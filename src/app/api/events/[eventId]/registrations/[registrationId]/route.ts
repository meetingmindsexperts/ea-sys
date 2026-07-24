import { NextResponse } from "next/server";
import { z } from "zod";
import { RegistrationStatus, AttendanceMode } from "@prisma/client";
import { holdsSeat, seatCounter } from "@/lib/registration-seat";
import { releaseEventSeats, releasePromoUsage, releaseSeat } from "@/lib/registration-seat-db";
import { releaseRoomForDeletedPerson } from "@/lib/accommodation-rooms";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { deletePhoto } from "@/lib/storage";
import { refreshEventStats } from "@/lib/event-stats";
import { optimisticLockField } from "@/lib/optimistic-lock";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import { canViewEntryBarcode, redactBarcodeFields } from "@/lib/barcode-visibility";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import {
  updateRegistration,
  type UpdateRegistrationErrorCode,
} from "@/services/registration-service";

// NOTE: `attendee.email` is intentionally NOT in this schema. Email is
// immutable at the general-purpose update path — use the dedicated
// `PATCH /api/events/[eventId]/registrations/[registrationId]/email`
// route instead, which performs the collision check + User.email cascade
// + Contact re-sync + audit log atomically. A plain field-level edit here
// would silently split identity across Registration / Attendee / User /
// Contact (the organizer-reported bug that motivated this lockdown).
const updateRegistrationSchema = z.object({
  ...optimisticLockField,
  status: z.nativeEnum(RegistrationStatus).optional(),
  // Admin-settable subset ONLY (review H12): PENDING / REFUNDED / FAILED are
  // owned by the Stripe webhook + the gated refund flow — a bare REFUNDED
  // flag here would cook the books (refundedAmount 0, no credit note, no
  // Payment flip, no audit). The UI already offers only this subset
  // (MANUAL_PAYMENT_STATUSES); this makes the server enforce it.
  paymentStatus: z
    .enum(["UNASSIGNED", "UNPAID", "PAID", "COMPLIMENTARY", "INCLUSIVE"])
    .optional(),
  // Sponsor attribution. When paymentStatus is being set to INCLUSIVE,
  // sponsorId must accompany it (validated below). Setting to null clears
  // the existing attribution. Leaving undefined leaves the existing value
  // untouched.
  sponsorId: z.string().min(1).max(100).optional().nullable(),
  // "Charge to another account" — reassign the payer post-hoc (finance
  // flips a self-pay reg to institution-billed, or null to revert to
  // self-pay; the latter is the fallback when the third party won't pay).
  // Validated org-scoped + active below. Orthogonal to paymentStatus.
  billingAccountId: z.string().min(1).max(100).optional().nullable(),
  payerReference: z.string().max(120).optional().nullable(),
  attendeeIsGuarantor: z.boolean().optional(),
  badgeType: z.string().max(50).optional().nullable(),
  dtcmBarcode: z.string().trim().max(255).optional().nullable(),
  ticketTypeId: z.string().cuid().optional(),
  // Re-classify the pricing tier post-create (e.g. give a late/onsite registrant
  // the Early Bird price). Unpaid-only; INACTIVE/closed tiers are allowed on
  // purpose; re-stamps originalPrice so every finance surface reflects it. null
  // clears the tier (→ base ticket-type price). See the validation block below.
  pricingTierId: z.string().cuid().optional().nullable(),
  // Hybrid attendance: move an existing registration between in-person and
  // virtual. virtual→in-person lazily mints an entry barcode + claims a venue
  // seat; in-person→virtual releases the seat (keeps the barcode for audit).
  // Seat accounting routes through planSeatTransition (src/lib/registration-seat).
  attendanceMode: z.nativeEnum(AttendanceMode).optional(),
  notes: z.string().max(2000).optional(),
  // Billing details — editable from the detail sheet so admins can correct
  // a typo'd tax number or update a bill-to address after submission.
  taxNumber: z.string().max(100).optional().nullable(),
  billingFirstName: z.string().max(100).optional().nullable(),
  billingLastName: z.string().max(100).optional().nullable(),
  billingEmail: z.string().email().max(255).optional().nullable().or(z.literal("")),
  billingPhone: z.string().max(50).optional().nullable(),
  billingAddress: z.string().max(500).optional().nullable(),
  billingCity: z.string().max(255).optional().nullable(),
  billingState: z.string().max(255).optional().nullable(),
  billingZipCode: z.string().max(20).optional().nullable(),
  billingCountry: z.string().max(255).optional().nullable(),
  attendee: z.object({
    title: titleEnum.optional().nullable(),
    role: attendeeRoleEnum.optional().nullable(),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    // Secondary inbox auto-CC'd on outgoing registration emails. Empty
    // string clears it; undefined leaves it untouched. Email format is
    // validated unless the value is the literal empty string (the UI
    // sends "" when the admin deletes the input contents to clear).
    additionalEmail: z.string().email().max(255).optional().nullable().or(z.literal("")),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    photo: z.string().max(500).optional().nullable().or(z.literal("")),
    city: z.string().max(255).optional(),
    country: z.string().max(255).optional(),
    bio: z.string().max(5000).optional(),
    specialty: z.string().max(255).optional(),
    tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    associationName: z.string().max(255).optional().nullable(),
    memberId: z.string().max(100).optional().nullable(),
    studentId: z.string().max(100).optional().nullable(),
    studentIdExpiry: z.string().max(20).optional().nullable(),
    customFields: z.record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  }).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

/** Map updateRegistration service error codes to HTTP statuses (repricing
 *  errors carry their own resolver status and are mapped in-line). */
const HTTP_STATUS_FOR_UPDATE_CODE: Partial<Record<UpdateRegistrationErrorCode, number>> = {
  REGISTRATION_NOT_FOUND: 404,
  TICKET_TYPE_NOT_FOUND: 404,
  BILLING_ACCOUNT_NOT_FOUND: 404,
  BILLING_ACCOUNT_INACTIVE: 400,
  INCLUSIVE_REQUIRES_SPONSOR: 400,
  SPONSOR_NOT_FOUND: 400,
  PAYMENT_STATUS_NOT_SETTABLE: 400,
  INVALID_STUDENT_ID_EXPIRY: 400,
  INVALID_STATUS: 400,
  INVALID_ATTENDANCE_MODE: 400,
  UNIQUE_CONSTRAINT: 409,
  STALE_WRITE: 409,
  CAPACITY_EXCEEDED: 409,
  EVENT_FULL: 409,
  UNKNOWN: 500,
};

export async function GET(req: Request, { params }: RouteParams) {
  try {
    // Parallelize all async operations
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parallelize event check, registration fetch, and the credited-so-far sum.
    const [event, registration, creditedAgg] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        // taxRate/taxLabel feed the `financials` block so the Payment
        // block + Payment Summary match the quote/invoice VAT math.
        select: { id: true, taxRate: true, taxLabel: true },
      }),
      db.registration.findFirst({
        where: {
          id: registrationId,
          eventId,
          // H8 (check-in review): a REGISTRANT reaches this route via bare
          // auth() + buildEventAccessWhere's registration-linkage, but the row
          // was bound only to the event — so any registration id in an event
          // they hold a registration for leaked that person's full payload
          // (incl. entry barcode). Bind org-null attendee roles to their OWN
          // row; org staff (ADMIN/ORGANIZER/MEMBER/ONSITE) are unaffected.
          ...(session.user.role === "REGISTRANT" && { userId: session.user.id }),
        },
        include: {
          attendee: true,
          ticketType: true,
          // Pricing tier (Early Bird / Standard / Onsite) — surfaced as a
          // read-only field on the Details tab. Only the PUT re-fetch
          // included this before, so a freshly-opened detail sheet always
          // showed "no tier" even when one was set.
          pricingTier: true,
          // "Charge to another account" — payer for the Billed-to display
          // + reassignment control. Redacted for MEMBER (financial).
          billingAccount: {
            select: { id: true, name: true, type: true, email: true, taxNumber: true },
          },
          // Applied promo code — organizer can apply/remove one on the
          // Billing tab while payment is still outstanding.
          promoCode: { select: { code: true } },
          payments: {
            orderBy: { createdAt: "desc" },
          },
          accommodation: {
            include: {
              roomType: {
                include: {
                  hotel: {
                    select: { id: true, name: true },
                  },
                },
              },
            },
          },
        },
      }),
      // Sum of non-cancelled credit notes — drives whether the refund button is
      // enabled (a credit note must exist before a refund can be issued).
      db.invoice.aggregate({
        where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
        _sum: { total: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // Money breakdown — single source of truth shared with the quote/
    // invoice VAT math. Surfaced as `financials` for the detail-sheet
    // Payment block + Payment Summary. `totalPaid` mirrors the existing
    // detail-sheet rule (succeeded/PAID payments only) so a partial
    // bank-transfer capture correctly leaves a balance.
    // Prefer the stamped originalPrice so tier-priced (base 0, no tier) and
    // VIRTUAL registrations don't wrongly resolve to 0 → "Free registration".
    const subtotal = readRegistrationBasePrice(registration);
    const currency =
      registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
    const totalPaid = (registration.payments ?? [])
      .filter((p) => p.status?.toLowerCase() === "succeeded" || p.status === "PAID")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const baseFinancials = computeRegistrationFinancials({
      subtotal,
      discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
      taxRate: event.taxRate ? Number(event.taxRate) : null,
      taxLabel: event.taxLabel,
      currency,
      totalPaid,
    });
    // Refund progress: `paidTotal` is what was collected (payments when present,
    // else the computed total for a hand-flipped PAID reg); `refundedAmount` is
    // the running total already refunded. Drives the "Refunded X of Y" line +
    // the default partial-refund amount.
    const refundedAmount = Number(registration.refundedAmount ?? 0);
    // A CANCELLED registration owes nothing — the balance shows 0 and it's not
    // chased. The price (total/subtotal) is kept for history/reporting.
    const isCancelled = registration.status === "CANCELLED";
    const financials = {
      ...baseFinancials,
      ...(isCancelled ? { balanceDue: 0, hasOutstandingBalance: false } : {}),
      refundedAmount,
      paidTotal: totalPaid > 0 ? totalPaid : baseFinancials.total,
      creditedAmount: Number(creditedAgg._sum.total ?? 0),
    };

    const withFinancials = { ...registration, financials };

    // MEMBER (read-only viewer) keeps the payment STATUS label but never
    // the amounts — `redactFinancialFields` strips the whole `financials`
    // block plus payments / invoices / billing. Defense in depth: even a
    // crafted request can't pull money out of this endpoint.
    let payload = canViewFinance(session.user.role)
      ? withFinancials
      : redactFinancialFields(withFinancials);

    // H6/H8: the entry barcode + DTCM code are physical-access credentials, not
    // financial fields — strip them for anyone who doesn't run the door/badges
    // (a MEMBER on the detail sheet is finance-capable but must not hold a door
    // credential; a REGISTRANT viewing their own row gets their barcode from the
    // portal, not this admin endpoint).
    if (!canViewEntryBarcode(session.user.role)) {
      payload = redactBarcodeFields(payload);
    }

    const response = NextResponse.json(payload);
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching registration" });
    return NextResponse.json(
      { error: "Failed to fetch registration" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  const { eventId, registrationId } = await params;
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Registration-desk roles (ONSITE + MEMBER) can edit a registration (incl.
    // payment status). DELETE stays admin/organizer-only (see below).
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    // Parallelize event access check + registration lookup. NOTE: the update
    // service re-reads both — this pre-check exists to preserve the response
    // ORDERING (404 / EMAIL_IMMUTABLE / Zod before any domain error) and the
    // access gate; do not "optimize" it away.
    const [event, existingRegistration] = await Promise.all([
      db.event.findFirst({
        // Assignment-scoped for ONSITE (per-event desk staff) — an ONSITE user
        // may only edit registrations for events they're assigned to. Org-scoped
        // (unchanged) for admin/organizer. Mirrors the GET above.
        where: buildEventAccessWhere(session.user, eventId),
        // taxRate/taxLabel feed the recomputed `financials` attached to the
        // PUT response so the detail sheet's Payment Summary refreshes after an
        // inline edit (e.g. a pricing-tier re-classification) without a
        // separate GET round-trip.
        select: { id: true, settings: true, taxRate: true, taxLabel: true },
      }),
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        include: { attendee: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingRegistration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const body = await req.json();

    // Email is immutable via the general-purpose update path. Return a
    // clear error code rather than silently stripping the field so clients
    // know to route through the dedicated email-change endpoint.
    if (
      body &&
      typeof body === "object" &&
      body.attendee &&
      typeof body.attendee === "object" &&
      "email" in body.attendee
    ) {
      return NextResponse.json(
        {
          error: "Email cannot be changed via this endpoint. Use PATCH /api/events/[eventId]/registrations/[registrationId]/email instead — it performs the collision check + User.email cascade + Contact re-sync atomically.",
          code: "EMAIL_IMMUTABLE",
        },
        { status: 400 }
      );
    }

    const validated = updateRegistrationSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({ msg: "Registration update validation failed", registrationId, errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { expectedUpdatedAt: _lockToken, ...updateFields } = validated.data;
    void _lockToken;

    // Domain logic — the sponsor invariant, billing-account/ticket-type
    // validation, shared repricing, seat/promo transition, optimistic lock,
    // attendee patch, and the audit/sync/stats fan-out — lives in
    // registration-service.updateRegistration (cross-caller #5: this route and
    // MCP update_registration used to hand-mirror it). This route keeps
    // session auth + desk-role gating + event access, the EMAIL_IMMUTABLE
    // guard, Zod, and the response shaping (financials + redaction).
    const result = await updateRegistration({
      eventId,
      registrationId,
      organizationId: session.user.organizationId!,
      actorUserId: session.user.id,
      source: "rest",
      requestIp: getClientIp(req),
      expectedUpdatedAt: validated.data.expectedUpdatedAt ?? null,
      ...updateFields,
    });

    if (!result.ok) {
      const httpStatus = HTTP_STATUS_FOR_UPDATE_CODE[result.code] ?? result.httpStatus ?? 400;
      // REPRICING_BLOCKED surfaces the resolver's own sub-code (e.g.
      // TIER_CHANGE_REQUIRES_UNPAID) + status, matching the pre-extraction
      // response shape.
      const code = result.code === "REPRICING_BLOCKED" ? (result.repricingCode ?? result.code) : result.code;
      return NextResponse.json(
        { error: result.message, code, ...(result.meta ?? {}) },
        { status: result.code === "REPRICING_BLOCKED" ? (result.httpStatus ?? 400) : httpStatus },
      );
    }

    const registration = result.registration;

    // Recompute the money breakdown on the fresh row — same single-source
    // block the GET uses — so the detail sheet's Payment Summary reflects the
    // edit immediately (a tier re-classification changes subtotal/total/VAT).
    // Without this the client shows `pricingTier` but a `financials`-less row,
    // which falls into the "no price set yet" branch even though a tier is set.
    const subtotal = readRegistrationBasePrice(registration);
    const totalPaid = (registration.payments ?? [])
      .filter((p) => p.status?.toLowerCase() === "succeeded" || p.status === "PAID")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const baseFinancials = computeRegistrationFinancials({
      subtotal,
      discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
      taxRate: event.taxRate ? Number(event.taxRate) : null,
      taxLabel: event.taxLabel,
      currency: registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD",
      totalPaid,
    });
    const refundedAmount = Number(registration.refundedAmount ?? 0);
    const creditedAgg = await db.invoice.aggregate({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      _sum: { total: true },
    });
    // A CANCELLED registration owes nothing — balance shows 0 (price kept for history).
    const isCancelled = registration.status === "CANCELLED";
    const financials = {
      ...baseFinancials,
      ...(isCancelled ? { balanceDue: 0, hasOutstandingBalance: false } : {}),
      refundedAmount,
      paidTotal: totalPaid > 0 ? totalPaid : baseFinancials.total,
      creditedAmount: Number(creditedAgg._sum.total ?? 0),
    };
    const withFinancials = { ...registration, financials };

    // ONSITE (registration-desk) can PUT but must never see amounts —
    // strip financials/payments/billing exactly like the GET does. MEMBER
    // can't reach this route (denyReviewer blocks it), but redact defensively.
    const payload = canViewFinance(session.user.role)
      ? withFinancials
      : redactFinancialFields(withFinancials);

    return NextResponse.json(payload);
  } catch (error) {
    // Domain failures (STALE_WRITE / CAPACITY_EXCEEDED / P2002 / repricing)
    // come back as result values from the service — this catch only sees
    // transport-level surprises.
    apiLogger.error({ err: error, msg: "Error updating registration" });
    return NextResponse.json(
      { error: "Failed to update registration" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { eventId, registrationId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId!,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await db.registration.findFirst({
      where: {
        id: registrationId,
        eventId,
      },
      include: { attendee: { select: { id: true, photo: true } } },
    });

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    // ── Data-loss guard: never cascade-delete financial records ──────────
    // Invoice + Payment both `onDelete: Cascade` from Registration, so deleting
    // a registration would silently destroy its invoices / receipts / credit
    // notes + payment history (the delete audit snapshots only the registration
    // row, not these). Block when any exist AND write a DELETE_BLOCKED audit
    // entry that snapshots them — a permanent trail of the attempt + the
    // protected records. Cancel the registration instead of deleting it.
    const [invoiceRecords, paymentRecords] = await Promise.all([
      db.invoice.findMany({
        where: { registrationId },
        select: { id: true, invoiceNumber: true, type: true, status: true, total: true, currency: true },
      }),
      db.payment.findMany({
        where: { registrationId },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          stripePaymentId: true,
          receiptUrl: true,
          paidAt: true,
          createdAt: true,
        },
      }),
    ]);

    if (invoiceRecords.length > 0 || paymentRecords.length > 0) {
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE_BLOCKED",
            entityType: "Registration",
            entityId: registrationId,
            changes: {
              reason: "has-financial-records",
              invoices: invoiceRecords,
              payments: paymentRecords,
              ip: getClientIp(req),
            },
          },
        })
        .catch((err) =>
          apiLogger.warn({ msg: "registration:delete-blocked-audit-failed", eventId, registrationId, err }),
        );
      apiLogger.warn({
        msg: "registration:delete-blocked-financial-records",
        eventId,
        registrationId,
        invoiceCount: invoiceRecords.length,
        paymentCount: paymentRecords.length,
      });
      const invNums = invoiceRecords.map((i) => i.invoiceNumber).join(", ");
      return NextResponse.json(
        {
          error:
            `This registration has ${invoiceRecords.length} invoice(s)` +
            `${invNums ? ` (${invNums})` : ""} and ${paymentRecords.length} payment(s). ` +
            "Deleting it would permanently remove those financial records. " +
            "Cancel the registration instead, or void/credit the invoices first.",
          code: "HAS_FINANCIAL_RECORDS",
          invoiceCount: invoiceRecords.length,
          paymentCount: paymentRecords.length,
        },
        { status: 409 },
      );
    }

    // Wrap soldCount decrement + delete in a transaction
    await db.$transaction(async (tx) => {
      // Release the seat this registration actually held, on the correct counter
      // (tier vs ticket type). Gating on holdsSeat also fixes the latent bug
      // where deleting a VIRTUAL (uncapped) reg wrongly decremented the counter.
      const heldSeat = holdsSeat(registration.status, registration.attendanceMode)
        ? seatCounter(registration)
        : null;
      if (heldSeat) {
        await releaseSeat(tx, heldSeat);
        // A registration that held a ticket/tier seat also held an event-wide
        // seat (Event.seatCount) — release it in the same tx.
        await releaseEventSeats(tx, eventId);
      }
      // DATA-1: release the promo code's usage count on delete (unless this row
      // was already CANCELLED, in which case the cancel already released it).
      // Guarded via the shared helper — never drives usedCount negative.
      if (registration.status !== "CANCELLED" && registration.promoCodeId) {
        await releasePromoUsage(tx, registration.promoCodeId);
      }
      // H4 (accommodation review): Accommodation cascade-deletes from
      // Registration, and a DB cascade fires no application code — so the
      // booking row would vanish while RoomType.bookedRooms kept counting it,
      // permanently. Release the room here, the same way the seat and the promo
      // usage are released above. No-ops when there's no booking or it's
      // already cancelled.
      await releaseRoomForDeletedPerson(tx, { registrationId });

      await tx.registration.delete({
        where: { id: registrationId },
      });
      // DATA-6: Attendees can be shared across multiple registrations (the
      // public-register orphan-reuse path produces this). Only delete the
      // Attendee when no OTHER registration references it — otherwise the
      // Restrict FK would throw and roll back the whole delete, and deleting it
      // would orphan siblings. (Same sibling-count guard the email-change route
      // uses before mutating a shared attendee.)
      if (registration.attendeeId) {
        const siblingCount = await tx.registration.count({
          where: { attendeeId: registration.attendeeId, id: { not: registrationId } },
        });
        if (siblingCount === 0) {
          await tx.attendee.delete({
            where: { id: registration.attendeeId },
          });
        }
      }
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Clean up photo file if present
    if (registration.attendee?.photo) {
      deletePhoto(registration.attendee.photo).catch((err) =>
        apiLogger.warn({ msg: "Failed to delete attendee photo", photo: registration.attendee?.photo, err })
      );
    }

    // Log the action. Fire-and-forget (M13): the delete transaction is already
    // committed — a transient audit-insert blip (P2024 pool class) must not
    // turn a completed delete into a user-facing 500.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "Registration",
          entityId: registrationId,
          changes: { deleted: registration, ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error(
          { err, eventId, registrationId },
          "registration-delete:audit-write-failed",
        ),
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting registration" });
    return NextResponse.json(
      { error: "Failed to delete registration" },
      { status: 500 }
    );
  }
}
