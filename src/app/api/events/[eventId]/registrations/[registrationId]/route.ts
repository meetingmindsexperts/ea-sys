import { NextResponse } from "next/server";
import { z } from "zod";
import { PaymentStatus, RegistrationStatus, AttendanceMode } from "@prisma/client";
import { planSeatTransition, needsQrCode } from "@/lib/registration-seat";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag, generateBarcode } from "@/lib/utils";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { titleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { deletePhoto } from "@/lib/storage";
import { refreshEventStats } from "@/lib/event-stats";
import { optimisticLockField } from "@/lib/optimistic-lock";
import { readSponsors } from "@/lib/webinar";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import { computeRegistrationFinancials } from "@/lib/registration-financials";

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
  paymentStatus: z.nativeEnum(PaymentStatus).optional(),
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

    // Parallelize event check and registration fetch
    const [event, registration] = await Promise.all([
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
    const subtotal = Number(
      registration.pricingTier?.price ?? registration.ticketType?.price ?? 0,
    );
    const currency =
      registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
    const totalPaid = (registration.payments ?? [])
      .filter((p) => p.status?.toLowerCase() === "succeeded" || p.status === "PAID")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const financials = computeRegistrationFinancials({
      subtotal,
      discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
      taxRate: event.taxRate ? Number(event.taxRate) : null,
      taxLabel: event.taxLabel,
      currency,
      totalPaid,
    });

    const withFinancials = { ...registration, financials };

    // MEMBER (read-only viewer) keeps the payment STATUS label but never
    // the amounts — `redactFinancialFields` strips the whole `financials`
    // block plus payments / invoices / billing. Defense in depth: even a
    // crafted request can't pull money out of this endpoint.
    const payload = canViewFinance(session.user.role)
      ? withFinancials
      : redactFinancialFields(withFinancials);

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

    // Parallelize event access check + registration lookup. `settings` is
    // included on the event so sponsorId can be validated against
    // Event.settings.sponsors[] without a second round-trip.
    const [event, existingRegistration] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, settings: true },
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

    const {
      status,
      paymentStatus,
      sponsorId,
      billingAccountId,
      payerReference,
      attendeeIsGuarantor,
      badgeType,
      dtcmBarcode,
      ticketTypeId,
      attendanceMode,
      notes,
      attendee,
      taxNumber,
      billingFirstName,
      billingLastName,
      billingEmail,
      billingPhone,
      billingAddress,
      billingCity,
      billingState,
      billingZipCode,
      billingCountry,
    } = validated.data;

    // Sponsor validation. Compute effective values (request override falls
    // back to existing). Per the "don't auto-clear" decision, sponsorId is
    // only cleared when the caller explicitly passes null; flipping
    // paymentStatus away from INCLUSIVE preserves the attribution so it
    // survives a revert.
    const effectivePaymentStatus = paymentStatus ?? existingRegistration.paymentStatus;
    const effectiveSponsorId =
      sponsorId === undefined ? existingRegistration.sponsorId : sponsorId;

    if (effectivePaymentStatus === PaymentStatus.INCLUSIVE && !effectiveSponsorId) {
      apiLogger.warn({
        msg: "registration-update:inclusive-requires-sponsor",
        registrationId,
        userId: session.user.id,
      });
      return NextResponse.json(
        {
          error:
            "paymentStatus=INCLUSIVE requires a sponsorId. Add the sponsor to the event's Sponsors page first, then reference its id.",
          code: "INCLUSIVE_REQUIRES_SPONSOR",
        },
        { status: 400 },
      );
    }

    if (effectiveSponsorId) {
      const sponsors = readSponsors(event.settings);
      const match = sponsors.find((s) => s.id === effectiveSponsorId);
      if (!match) {
        apiLogger.warn({
          msg: "registration-update:sponsor-not-found",
          registrationId,
          sponsorId: effectiveSponsorId,
        });
        return NextResponse.json(
          {
            error: `Sponsor ${effectiveSponsorId} not found in event's sponsor list.`,
            code: "SPONSOR_NOT_FOUND",
            availableSponsors: sponsors.map((s) => ({ id: s.id, name: s.name })),
          },
          { status: 400 },
        );
      }
    }

    // "Charge to another account" reassignment. `billingAccountId === null`
    // reverts to self-pay (the fallback path) — allowed without a lookup.
    // A non-null id must resolve to an active BillingAccount in this org
    // (org-scoped — never trust the id alone). Orthogonal to paymentStatus.
    if (typeof billingAccountId === "string") {
      const ba = await db.billingAccount.findFirst({
        where: { id: billingAccountId, organizationId: session.user.organizationId! },
        select: { id: true, isActive: true },
      });
      if (!ba) {
        apiLogger.warn({
          msg: "registration-update:billing-account-not-found",
          registrationId,
          billingAccountId,
        });
        return NextResponse.json(
          { error: `Billing account ${billingAccountId} not found in this organization.`, code: "BILLING_ACCOUNT_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (!ba.isActive) {
        return NextResponse.json(
          { error: `Billing account ${billingAccountId} is inactive.`, code: "BILLING_ACCOUNT_INACTIVE" },
          { status: 400 },
        );
      }
    }

    // Validate studentIdExpiry date format if provided
    if (attendee?.studentIdExpiry && isNaN(new Date(attendee.studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "Invalid studentIdExpiry date in registration update", registrationId, studentIdExpiry: attendee.studentIdExpiry });
      return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
    }

    // Update attendee if provided
    if (attendee) {
      await db.attendee.update({
        where: { id: existingRegistration.attendeeId },
        data: {
          ...(attendee.title !== undefined && { title: attendee.title || null }),
          ...(attendee.firstName && { firstName: attendee.firstName }),
          ...(attendee.lastName && { lastName: attendee.lastName }),
          // Empty-string clears the optional secondary email (rare but
          // valid — registrant may have typo'd it during signup). Trim
          // first so trailing whitespace doesn't slip a phantom value
          // past the "is it empty?" check below.
          ...(attendee.additionalEmail !== undefined && {
            additionalEmail: attendee.additionalEmail?.trim() || null,
          }),
          ...(attendee.organization !== undefined && { organization: attendee.organization || null }),
          ...(attendee.photo !== undefined && { photo: attendee.photo || null }),
          ...(attendee.jobTitle !== undefined && { jobTitle: attendee.jobTitle || null }),
          ...(attendee.phone !== undefined && { phone: attendee.phone || null }),
          ...(attendee.city !== undefined && { city: attendee.city || null }),
          ...(attendee.country !== undefined && { country: attendee.country || null }),
          ...(attendee.bio !== undefined && { bio: attendee.bio || null }),
          ...(attendee.specialty !== undefined && { specialty: attendee.specialty || null }),
          ...(attendee.tags !== undefined && { tags: attendee.tags }),
          ...(attendee.dietaryReqs !== undefined && { dietaryReqs: attendee.dietaryReqs || null }),
          ...(attendee.associationName !== undefined && { associationName: attendee.associationName || null }),
          ...(attendee.memberId !== undefined && { memberId: attendee.memberId || null }),
          ...(attendee.studentId !== undefined && { studentId: attendee.studentId || null }),
          ...(attendee.studentIdExpiry !== undefined && { studentIdExpiry: attendee.studentIdExpiry ? new Date(attendee.studentIdExpiry) : null }),
          ...(attendee.customFields && { customFields: attendee.customFields }),
        },
      });

      // Sync updated attendee to org contact store (awaited — errors caught internally)
      const a = existingRegistration.attendee;
      await syncToContact({
        organizationId: session.user.organizationId!,
        eventId,
        email: a.email,
        // Mirror the secondary inbox so the org Contact row stays in
        // step with the Attendee row. Trim+empty-to-null matches the
        // attendee update above; `undefined` (field absent from payload)
        // preserves whatever the Contact already had.
        additionalEmail: attendee.additionalEmail !== undefined
          ? (attendee.additionalEmail?.trim() || null)
          : a.additionalEmail,
        firstName: attendee.firstName || a.firstName,
        lastName: attendee.lastName || a.lastName,
        title: attendee.title !== undefined ? (attendee.title || null) : a.title,
        organization: attendee.organization !== undefined ? (attendee.organization || null) : a.organization,
        jobTitle: attendee.jobTitle !== undefined ? (attendee.jobTitle || null) : a.jobTitle,
        phone: attendee.phone !== undefined ? (attendee.phone || null) : a.phone,
        photo: attendee.photo !== undefined ? (attendee.photo || null) : a.photo,
        city: attendee.city !== undefined ? (attendee.city || null) : a.city,
        country: attendee.country !== undefined ? (attendee.country || null) : a.country,
        bio: attendee.bio !== undefined ? (attendee.bio || null) : a.bio,
        specialty: attendee.specialty !== undefined ? (attendee.specialty || null) : a.specialty,
        registrationType: a.registrationType,
        associationName: attendee.associationName !== undefined ? (attendee.associationName || null) : a.associationName,
        memberId: attendee.memberId !== undefined ? (attendee.memberId || null) : a.memberId,
        studentId: attendee.studentId !== undefined ? (attendee.studentId || null) : a.studentId,
        studentIdExpiry: attendee.studentIdExpiry !== undefined ? (attendee.studentIdExpiry ? new Date(attendee.studentIdExpiry) : null) : a.studentIdExpiry,
      });
    }

    const expectedUpdatedAt = validated.data.expectedUpdatedAt;
    if (!expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "registration",
        resourceId: registrationId,
      });
    }

    // Event-scope the requested ticket type (parity with the MCP path). Never
    // trust the id alone — without this a ticketTypeId from another event could
    // be claimed onto this registration's soldCount (and the in-tx lookup would
    // mis-report it as CAPACITY_EXCEEDED). Validate up front for a clean 404.
    if (ticketTypeId && ticketTypeId !== existingRegistration.ticketTypeId) {
      const tt = await db.ticketType.findFirst({
        where: { id: ticketTypeId, eventId },
        select: { id: true },
      });
      if (!tt) {
        apiLogger.warn({ msg: "registration-update:ticket-type-not-found", registrationId, ticketTypeId });
        return NextResponse.json(
          { error: `Ticket type ${ticketTypeId} not found in this event.`, code: "TICKET_TYPE_NOT_FOUND" },
          { status: 404 },
        );
      }
    }

    // Wrap soldCount + registration update in a transaction to prevent race
    // conditions on the soldCount counter, AND to make the optimistic lock
    // atomic with the soldCount adjustments — so a stale-write rejection
    // rolls back any decrement/increment we just did to the related
    // ticketType row.
    const registration = await db.$transaction(async (tx) => {
      const effectiveStatus = status || existingRegistration.status;
      const effectiveMode = attendanceMode || existingRegistration.attendanceMode;
      const effectiveTypeId = ticketTypeId || existingRegistration.ticketTypeId;
      const isBecomingCancelled = effectiveStatus === "CANCELLED" && existingRegistration.status !== "CANCELLED";
      const isChangingType = ticketTypeId && ticketTypeId !== existingRegistration.ticketTypeId;

      // Seat accounting (TicketType.soldCount) — routed through the single seat
      // model so status / attendanceMode / ticketType changes are all handled
      // correctly. A VIRTUAL registration holds no venue seat, so cancelling /
      // reactivating / type-changing it no longer moves the counter (the old
      // status-only logic mis-counted those). The atomic `soldCount < quantity`
      // predicate on each claim is the oversell guard; a virtual→in-person on a
      // sold-out type hard-fails CAPACITY_EXCEEDED (the reg stays virtual — a
      // valid state — so nobody is stranded).
      const seat = planSeatTransition(
        {
          status: existingRegistration.status,
          attendanceMode: existingRegistration.attendanceMode,
          ticketTypeId: existingRegistration.ticketTypeId,
        },
        { status: effectiveStatus, attendanceMode: effectiveMode, ticketTypeId: effectiveTypeId },
      );
      if (seat.release) {
        await tx.ticketType.update({
          where: { id: seat.release },
          data: { soldCount: { decrement: 1 } },
        });
      }
      if (seat.claim) {
        const ticket = await tx.ticketType.findUnique({
          where: { id: seat.claim },
          select: { quantity: true },
        });
        if (!ticket) {
          throw new Error("CAPACITY_EXCEEDED");
        }
        const claimed = await tx.ticketType.updateMany({
          where: { id: seat.claim, soldCount: { lt: ticket.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw new Error("CAPACITY_EXCEEDED");
        }
      }

      // Keep attendee.registrationType synced with the ticket type name when
      // the type changes (independent of seat movement — applies to virtual too).
      if (isChangingType) {
        const newTicket = await tx.ticketType.findUnique({
          where: { id: ticketTypeId },
          select: { name: true },
        });
        if (!newTicket) {
          throw new Error("CAPACITY_EXCEEDED");
        }
        await tx.attendee.update({
          where: { id: existingRegistration.attendeeId },
          data: { registrationType: newTicket.name },
        });
      }

      // DATA-1: release the promo code's usage count when a registration that
      // consumed one is cancelled. The public-register path increments
      // `usedCount` when a promo is applied; without this release a limited-use
      // code stays permanently "used" after a cancel and wrongly rejects new
      // eligible registrants. Guarded by `isBecomingCancelled` so it fires once.
      if (isBecomingCancelled && existingRegistration.promoCodeId) {
        await tx.promoCode.update({
          where: { id: existingRegistration.promoCodeId },
          data: { usedCount: { decrement: 1 } },
        });
      }

      const changeData = {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
        ...(sponsorId !== undefined && { sponsorId }),
        ...(billingAccountId !== undefined && { billingAccountId }),
        ...(payerReference !== undefined && { payerReference: payerReference || null }),
        ...(attendeeIsGuarantor !== undefined && { attendeeIsGuarantor }),
        ...(badgeType !== undefined && { badgeType }),
        ...(dtcmBarcode !== undefined && { dtcmBarcode: dtcmBarcode || null }),
        ...(ticketTypeId && { ticketTypeId }),
        ...(attendanceMode !== undefined && { attendanceMode }),
        // Lazy entry-barcode mint: a registration becoming (or already)
        // in-person with no barcode gets one — the virtual→in-person fix so
        // it can be badged + checked in. Virtual keeps null; an existing
        // barcode is preserved (going in-person→virtual keeps it for audit).
        ...(needsQrCode(effectiveMode, existingRegistration.qrCode) && { qrCode: generateBarcode() }),
        ...(notes !== undefined && { notes: notes || null }),
        ...(taxNumber !== undefined && { taxNumber: taxNumber || null }),
        ...(billingFirstName !== undefined && { billingFirstName: billingFirstName || null }),
        ...(billingLastName !== undefined && { billingLastName: billingLastName || null }),
        ...(billingEmail !== undefined && { billingEmail: billingEmail || null }),
        ...(billingPhone !== undefined && { billingPhone: billingPhone || null }),
        ...(billingAddress !== undefined && { billingAddress: billingAddress || null }),
        ...(billingCity !== undefined && { billingCity: billingCity || null }),
        ...(billingState !== undefined && { billingState: billingState || null }),
        ...(billingZipCode !== undefined && { billingZipCode: billingZipCode || null }),
        ...(billingCountry !== undefined && { billingCountry: billingCountry || null }),
        updatedAt: new Date(),
      };

      // Optimistic lock: when the client sent expectedUpdatedAt, write
      // only if the row still has that timestamp. Throws STALE_WRITE
      // through the catch block (and rolls back the soldCount changes
      // above by virtue of being inside the transaction).
      const updateResult = await tx.registration.updateMany({
        where: {
          id: registrationId,
          ...(expectedUpdatedAt && { updatedAt: new Date(expectedUpdatedAt) }),
        },
        data: changeData,
      });
      if (updateResult.count === 0) {
        throw new Error(expectedUpdatedAt ? "STALE_WRITE" : "REGISTRATION_DISAPPEARED");
      }

      return tx.registration.findUniqueOrThrow({
        where: { id: registrationId },
        include: {
          attendee: true,
          ticketType: true,
          pricingTier: true,
          payments: {
            select: { id: true, amount: true, currency: true, status: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
          accommodation: {
            select: {
              id: true, checkIn: true, checkOut: true, status: true,
              roomType: { select: { name: true, hotel: { select: { name: true } } } },
            },
          },
        },
      });
    });

    if (!registration) {
      return NextResponse.json({ error: "Failed to update registration" }, { status: 500 });
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UPDATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          before: existingRegistration,
          after: registration,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(registration);
  } catch (error) {
    if (error instanceof Error && error.message === "CAPACITY_EXCEEDED") {
      return NextResponse.json(
        { error: "Registration type is at full capacity" },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === "STALE_WRITE") {
      apiLogger.info({ msg: "registration:stale-write-rejected", registrationId });
      return NextResponse.json(
        {
          error: "This registration was modified by someone else after you opened it. Reload the latest version and try again.",
          code: "STALE_WRITE",
        },
        { status: 409 }
      );
    }
    if (error instanceof Error && error.message === "REGISTRATION_DISAPPEARED") {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }
    // P2002 unique constraint violation — most likely on dtcmBarcode
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      const target = (error as { meta?: { target?: string[] } }).meta?.target;
      apiLogger.warn({ msg: "Registration update unique constraint violation", target, registrationId });
      if (target?.includes("dtcmBarcode")) {
        return NextResponse.json(
          { error: "This DTCM barcode is already assigned to another registration." },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "A unique constraint was violated." },
        { status: 409 }
      );
    }
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

    // Wrap soldCount decrement + delete in a transaction
    await db.$transaction(async (tx) => {
      if (registration.status !== "CANCELLED" && registration.ticketTypeId) {
        await tx.ticketType.update({
          where: { id: registration.ticketTypeId },
          data: { soldCount: { decrement: 1 } },
        });
      }
      // DATA-1: release the promo code's usage count on delete (unless this row
      // was already CANCELLED, in which case the cancel already released it).
      if (registration.status !== "CANCELLED" && registration.promoCodeId) {
        await tx.promoCode.update({
          where: { id: registration.promoCodeId },
          data: { usedCount: { decrement: 1 } },
        });
      }
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

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Registration",
        entityId: registrationId,
        changes: { deleted: registration, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting registration" });
    return NextResponse.json(
      { error: "Failed to delete registration" },
      { status: 500 }
    );
  }
}
