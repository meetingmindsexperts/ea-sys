/**
 * Registration service — domain logic for admin-driven registration create.
 *
 * Shared by the REST admin POST route and the MCP agent tool. Phase 0
 * previously patched the MCP `create_registration` executor to full REST
 * parity (confirmation email + quote PDF, paymentStatus defaults, atomic
 * soldCount, qrCode, syncToContact, audit, notifyEventAdmins,
 * sales-window enforcement, CANCELLED-exclusion in duplicate check). This
 * extraction consolidates those two already-aligned paths onto one function
 * so they can't drift again, and establishes the service shape that the
 * external public REST API (Phase 3) will reuse when it lands.
 *
 * Scope explicitly excludes:
 *   - Public register (/api/public/events/[slug]/register) — different
 *     caller (unauthenticated), creates Stripe checkout session, creates
 *     REGISTRANT user accounts, reuses orphan attendees, auto-creates
 *     invoices. Significant unique concerns — worth its own extraction.
 *   - MCP bulk (create_registrations_bulk) — per-row error capture,
 *     different response shape. Not a fit for single-create service.
 *
 * See src/services/README.md for the shared conventions.
 */

import type { Prisma } from "@prisma/client";
import { PaymentStatus, RegistrationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import { sendRegistrationConfirmation } from "@/lib/email";

// ── Constants (shared with callers) ──────────────────────────────────────────

/**
 * Payment statuses where the registrant still owes money — trigger the
 * confirmation email + quote PDF attachment. Skip PAID/COMPLIMENTARY
 * (admin settled) and Stripe-driven REFUNDED/FAILED (admin can re-send
 * manually from the detail sheet if needed).
 */
const OUTSTANDING_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PENDING,
]);

/**
 * Admin-settable subset. Stripe-driven states (PENDING / REFUNDED /
 * FAILED) are excluded because the webhook owns those.
 */
export const MANUAL_PAYMENT_STATUSES = [
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PAID,
  PaymentStatus.COMPLIMENTARY,
] as const;
export type ManualPaymentStatus = (typeof MANUAL_PAYMENT_STATUSES)[number];

/**
 * Manual statuses an admin/agent may set at creation time. `CANCELLED`
 * is reachable only via the update path. `CHECKED_IN` is reached via
 * the check-in flow.
 */
export const MANUAL_REGISTRATION_STATUSES = [
  RegistrationStatus.PENDING,
  RegistrationStatus.CONFIRMED,
  RegistrationStatus.WAITLISTED,
] as const;
export type ManualRegistrationStatus = (typeof MANUAL_REGISTRATION_STATUSES)[number];

// ── Input / Result types ─────────────────────────────────────────────────────

export type RegistrationTitle = "DR" | "MR" | "MRS" | "MS" | "PROF";

/**
 * Attendee's demographic / professional role. Mirrors the Prisma
 * `AttendeeRole` enum; listed inline to keep this module free of
 * Prisma-namespace coupling at the public-input boundary.
 */
export type RegistrationAttendeeRole =
  | "ACADEMIA"
  | "ALLIED_HEALTH"
  | "MEDICAL_DEVICES"
  | "PHARMA"
  | "PHYSICIAN"
  | "RESIDENT"
  | "SPEAKER"
  | "STUDENT"
  | "OTHERS";

export interface CreateRegistrationInput {
  eventId: string;
  organizationId: string;
  userId: string;

  /**
   * Optional — when present, validates against the event, enforces sales
   * window + sold-out + requiresApproval, increments soldCount atomically
   * inside the tx. When absent, registration is created without a ticket
   * type (paymentStatus defaults to COMPLIMENTARY).
   */
  ticketTypeId?: string | null;

  /**
   * Optional pricing tier that must belong to the ticket type above.
   * Ignored when ticketTypeId is absent.
   */
  pricingTierId?: string | null;

  /**
   * Attendee payload. `email` is normalized (trim + lowercase) inside
   * the service — callers can pass raw. The rest is pass-through with
   * empty-string-to-null coercion so direct-to-service callers can't
   * accidentally store `""` in optional columns.
   */
  attendee: {
    title?: RegistrationTitle | null;
    /** Demographic / professional classification (PHYSICIAN, STUDENT, ...). */
    role?: RegistrationAttendeeRole | null;
    email: string;
    /** Secondary email — public form collects it; cc on notifications. */
    additionalEmail?: string | null;
    firstName: string;
    lastName: string;
    organization?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
    photo?: string | null;
    city?: string | null;
    state?: string | null;
    zipCode?: string | null;
    country?: string | null;
    bio?: string | null;
    specialty?: string | null;
    /** Free-text when `specialty === "Others"`. */
    customSpecialty?: string | null;
    tags?: string[];
    dietaryReqs?: string | null;
    /** Membership / student registration fields. */
    associationName?: string | null;
    memberId?: string | null;
    studentId?: string | null;
    /**
     * ISO 8601 date string (`YYYY-MM-DD`) from callers, coerced to `Date`
     * inside the service. Accept either so REST callers don't have to
     * pre-parse and the service owns the conversion.
     */
    studentIdExpiry?: string | Date | null;
    customFields?: Prisma.InputJsonValue;
  };

  /**
   * Free-form notes attached to the registration row. Admin UI uses
   * this for internal remarks.
   */
  notes?: string | null;

  /**
   * Caller-supplied registration status. Defaults to `CONFIRMED`. When
   * the ticket type has `requiresApproval: true`, this is overridden to
   * `PENDING` regardless of the caller's input.
   */
  status?: ManualRegistrationStatus;

  /**
   * Caller-supplied payment status. Defaults:
   *   - `COMPLIMENTARY` when there's no ticketType, or ticketType.price === 0
   *   - `UNASSIGNED` for paid tickets
   *
   * Stripe-driven states (PENDING / REFUNDED / FAILED) must not be set
   * here — the webhook owns those. Callers that pass them get
   * INVALID_PAYMENT_STATUS.
   */
  paymentStatus?: ManualPaymentStatus;

  /** Caller identity — written into `AuditLog.changes.source`. */
  source: "rest" | "mcp" | "api";

  /** REST callers pass `getClientIp(req)`. MCP omits. */
  requestIp?: string;

  /**
   * Used in the admin-notification message for REST callers (shows
   * who added the registration). Optional; falls back to "organizer"
   * for MCP / external-API paths where there's no human name.
   */
  actorFirstName?: string | null;
}

export type CreateRegistrationErrorCode =
  | "EVENT_NOT_FOUND"
  | "TICKET_TYPE_NOT_FOUND"
  | "SALES_NOT_STARTED"
  | "SALES_ENDED"
  | "SOLD_OUT"
  | "PRICING_TIER_NOT_FOUND"
  | "ALREADY_REGISTERED"
  | "INVALID_PAYMENT_STATUS"
  | "UNKNOWN";

type RegistrationWithRelations = Prisma.RegistrationGetPayload<{
  include: { attendee: true; ticketType: true };
}>;

export type CreateRegistrationResult =
  | {
      ok: true;
      registration: RegistrationWithRelations;
    }
  | {
      ok: false;
      code: CreateRegistrationErrorCode;
      message: string;
      meta?: Record<string, unknown>;
    };

// ── Service ──────────────────────────────────────────────────────────────────

export async function createRegistration(
  input: CreateRegistrationInput,
): Promise<CreateRegistrationResult> {
  const {
    eventId,
    organizationId,
    userId,
    ticketTypeId,
    pricingTierId,
    notes,
    source,
    requestIp,
    actorFirstName,
  } = input;

  // Normalize attendee inputs. Empty-string-to-null so direct-to-service
  // callers match REST + MCP behavior without having to pre-clean.
  const email = input.attendee.email.trim().toLowerCase();
  const firstName = input.attendee.firstName;
  const lastName = input.attendee.lastName;
  const attendeeTitle = input.attendee.title ?? null;
  const attendeeRole = input.attendee.role ?? null;
  // `additionalEmail` — public form accepts empty string meaning "not
  // provided"; coerce to null so the DB column stays nullable-clean.
  const additionalEmail = input.attendee.additionalEmail
    ? input.attendee.additionalEmail.trim().toLowerCase()
    : null;
  const organization = input.attendee.organization || null;
  const jobTitle = input.attendee.jobTitle || null;
  const phone = input.attendee.phone || null;
  const photo = input.attendee.photo || null;
  const city = input.attendee.city || null;
  const state = input.attendee.state || null;
  const zipCode = input.attendee.zipCode || null;
  const country = input.attendee.country || null;
  const bio = input.attendee.bio || null;
  const specialty = input.attendee.specialty || null;
  const customSpecialty = input.attendee.customSpecialty || null;
  const tags = input.attendee.tags ?? [];
  const dietaryReqs = input.attendee.dietaryReqs || null;
  const associationName = input.attendee.associationName || null;
  const memberId = input.attendee.memberId || null;
  const studentId = input.attendee.studentId || null;
  // Accept either a Date or an ISO string from callers; normalize to Date
  // (or null on empty string / invalid date). An invalid date falls to
  // null rather than throwing — matches the "trust input, don't crash on
  // bad data" boundary-safe posture of the service.
  let studentIdExpiry: Date | null = null;
  if (input.attendee.studentIdExpiry) {
    const raw = input.attendee.studentIdExpiry;
    const parsed = raw instanceof Date ? raw : new Date(raw);
    studentIdExpiry = isNaN(parsed.getTime()) ? null : parsed;
  }
  const customFields = input.attendee.customFields ?? {};

  // Validate paymentStatus input up front. Runtime check because callers
  // may pass stringly-typed values from JSON.
  if (
    input.paymentStatus !== undefined &&
    !MANUAL_PAYMENT_STATUSES.includes(input.paymentStatus)
  ) {
    return {
      ok: false,
      code: "INVALID_PAYMENT_STATUS",
      message:
        `Invalid paymentStatus "${input.paymentStatus}". Must be one of: ` +
        `${MANUAL_PAYMENT_STATUSES.join(", ")}. ` +
        `Stripe-driven states (PENDING / REFUNDED / FAILED) are webhook-owned.`,
      meta: { allowed: [...MANUAL_PAYMENT_STATUSES] },
    };
  }

  // Load event + ticket type in parallel. Event select carries everything
  // sendRegistrationConfirmation needs so we don't re-query post-transaction.
  const [event, ticketType] = await Promise.all([
    db.event.findFirst({
      where: { id: eventId, organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        startDate: true,
        venue: true,
        city: true,
        taxRate: true,
        taxLabel: true,
        bankDetails: true,
        supportEmail: true,
        organizationId: true,
        organization: {
          select: {
            name: true,
            companyName: true,
            companyAddress: true,
            companyCity: true,
            companyState: true,
            companyZipCode: true,
            companyCountry: true,
            taxId: true,
            logo: true,
          },
        },
      },
    }),
    ticketTypeId
      ? db.ticketType.findFirst({
          where: { id: ticketTypeId, eventId, isActive: true },
          select: {
            id: true,
            name: true,
            price: true,
            currency: true,
            quantity: true,
            soldCount: true,
            salesStart: true,
            salesEnd: true,
            requiresApproval: true,
          },
        })
      : null,
  ]);

  if (!event) {
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found" };
  }
  if (ticketTypeId && !ticketType) {
    return {
      ok: false,
      code: "TICKET_TYPE_NOT_FOUND",
      message: "Registration type not found or inactive",
    };
  }

  // Sales-window + sold-out pre-check. The atomic guard inside the tx
  // is the race-safety net — this pre-check short-circuits for the
  // common case where the caller is already past the window and saves
  // the attendee.create round-trip.
  if (ticketType) {
    const now = new Date();
    if (ticketType.salesStart && new Date(ticketType.salesStart) > now) {
      return {
        ok: false,
        code: "SALES_NOT_STARTED",
        message: "Ticket sales have not started",
      };
    }
    if (ticketType.salesEnd && new Date(ticketType.salesEnd) < now) {
      return {
        ok: false,
        code: "SALES_ENDED",
        message: "Ticket sales have ended",
      };
    }
    if (ticketType.soldCount >= ticketType.quantity) {
      return { ok: false, code: "SOLD_OUT", message: "Tickets sold out" };
    }
  }

  // Validate pricingTierId (if provided) belongs to the ticket type.
  let validPricingTierId: string | null = null;
  if (pricingTierId && ticketType) {
    const tier = await db.pricingTier.findFirst({
      where: { id: pricingTierId, ticketTypeId: ticketType.id },
      select: { id: true },
    });
    if (!tier) {
      return {
        ok: false,
        code: "PRICING_TIER_NOT_FOUND",
        message: "Pricing tier not found for this ticket type",
      };
    }
    validPricingTierId = tier.id;
  }

  // Default paymentStatus: UNASSIGNED for paid tickets, COMPLIMENTARY for
  // free (no ticket type OR price === 0). Caller override takes priority.
  const isFree = !ticketType || Number(ticketType.price) === 0;
  const defaultPaymentStatus: ManualPaymentStatus = isFree
    ? PaymentStatus.COMPLIMENTARY
    : PaymentStatus.UNASSIGNED;
  const finalPaymentStatus: ManualPaymentStatus =
    input.paymentStatus ?? defaultPaymentStatus;

  // Respect requiresApproval — if the ticket type needs approval, the
  // registration starts PENDING regardless of caller input.
  const rawStatus: ManualRegistrationStatus =
    input.status ?? RegistrationStatus.CONFIRMED;
  const finalStatus: RegistrationStatus = ticketType?.requiresApproval
    ? RegistrationStatus.PENDING
    : rawStatus;

  // Atomic: duplicate check + attendee create + soldCount increment +
  // registration create, all in one transaction. Throws with sentinels
  // that are caught in the outer catch and mapped to error codes.
  let registration: RegistrationWithRelations;
  try {
    registration = await db.$transaction(async (tx) => {
      // Dup check excludes CANCELLED — matches REST + MCP behavior post-Phase-0
      // so a re-registration after cancellation is allowed.
      const existing = await tx.registration.findFirst({
        where: {
          eventId,
          attendee: { email },
          status: { notIn: [RegistrationStatus.CANCELLED] },
        },
        select: { id: true },
      });
      if (existing) {
        throw new RegistrationServiceSentinel("ALREADY_REGISTERED", {
          existingRegistrationId: existing.id,
        });
      }

      const attendeeRecord = await tx.attendee.create({
        data: {
          title: attendeeTitle,
          role: attendeeRole,
          email,
          additionalEmail,
          firstName,
          lastName,
          organization,
          jobTitle,
          phone,
          photo,
          city,
          state,
          zipCode,
          country,
          bio,
          specialty,
          customSpecialty,
          registrationType: ticketType?.name || null,
          tags,
          dietaryReqs,
          associationName,
          memberId,
          studentId,
          studentIdExpiry,
          customFields: customFields as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // Atomic soldCount increment with sold-out guard inside the tx —
      // prevents overbooking under concurrent admin + public + MCP registrations.
      if (ticketType && ticketTypeId) {
        const updated = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw new RegistrationServiceSentinel("SOLD_OUT", {});
        }
      }

      const qrCode = generateBarcode();
      const serialId = await getNextSerialId(tx, eventId);
      return tx.registration.create({
        data: {
          eventId,
          ticketTypeId: ticketTypeId || null,
          pricingTierId: validPricingTierId,
          attendeeId: attendeeRecord.id,
          serialId,
          status: finalStatus,
          paymentStatus: finalPaymentStatus,
          qrCode,
          notes: notes || null,
        },
        include: { attendee: true, ticketType: true },
      });
    });
  } catch (err) {
    if (err instanceof RegistrationServiceSentinel) {
      if (err.code === "ALREADY_REGISTERED") {
        return {
          ok: false,
          code: "ALREADY_REGISTERED",
          message: `A registration for ${email} already exists for this event`,
          meta: err.meta,
        };
      }
      if (err.code === "SOLD_OUT") {
        return {
          ok: false,
          code: "SOLD_OUT",
          message: "Tickets sold out (race: sold out between pre-check and commit)",
        };
      }
    }
    apiLogger.error({ err, eventId, email }, "registration-service:create-failed");
    return {
      ok: false,
      code: "UNKNOWN",
      message: err instanceof Error ? err.message : "Failed to create registration",
    };
  }

  // ── Post-commit side effects ───────────────────────────────────────────────

  // Sync to org contact store (awaited; errors caught inside syncToContact).
  // Threads the full attendee payload — Contact model mirrors Attendee
  // so none of these drop on the other side.
  await syncToContact({
    organizationId,
    eventId,
    email,
    firstName,
    lastName,
    title: attendeeTitle,
    role: attendeeRole,
    additionalEmail,
    organization,
    jobTitle,
    phone,
    photo,
    city,
    state,
    zipCode,
    country,
    bio,
    specialty,
    customSpecialty,
    registrationType: ticketType?.name || null,
    associationName,
    memberId,
    studentId,
    studentIdExpiry,
  });

  // Refresh denormalized event stats (fire-and-forget).
  refreshEventStats(eventId);

  // Audit log (fire-and-forget). `changes.source` identifies the caller;
  // REST attaches `ip` from getClientIp, MCP/API omit.
  db.auditLog
    .create({
      data: {
        eventId,
        userId,
        action: "CREATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          source,
          ticketTypeId: ticketType?.id ?? null,
          paymentStatus: finalPaymentStatus,
          status: finalStatus,
          ...(requestIp ? { ip: requestIp } : {}),
        },
      },
    })
    .catch((err) =>
      apiLogger.error({ err }, "registration-service:audit-log-failed"),
    );

  // Notify admins (fire-and-forget). Message names the actor when
  // available, falls back to "organizer" for non-human callers.
  const actorLabel = actorFirstName || "organizer";
  notifyEventAdmins(eventId, {
    type: "REGISTRATION",
    title: "Registration Added",
    message:
      source === "mcp"
        ? `${firstName} ${lastName} added via MCP`
        : `${firstName} ${lastName} added by ${actorLabel}`,
    link: `/events/${eventId}/registrations`,
  }).catch((err) =>
    apiLogger.error({ err }, "registration-service:notify-admins-failed"),
  );

  // Send confirmation + quote PDF when the registrant still owes money.
  // Quote PDF auto-attaches inside sendRegistrationConfirmation when
  // ticketPrice > 0 && organizationName. Skip for free + already-settled
  // + Stripe-driven states.
  if (
    ticketType &&
    Number(ticketType.price) > 0 &&
    OUTSTANDING_PAYMENT_STATUSES.has(finalPaymentStatus)
  ) {
    sendRegistrationConfirmation({
      to: email,
      firstName,
      lastName,
      title: attendeeTitle,
      organization,
      jobTitle,
      eventName: event.name,
      eventDate: event.startDate,
      eventVenue: event.venue || "",
      eventCity: event.city || "",
      ticketType: ticketType.name,
      registrationId: registration.id,
      serialId: registration.serialId,
      qrCode: registration.qrCode || "",
      eventId: event.id,
      eventSlug: event.slug,
      ticketPrice: Number(ticketType.price),
      ticketCurrency: ticketType.currency,
      taxRate: event.taxRate ? Number(event.taxRate) : null,
      taxLabel: event.taxLabel,
      bankDetails: event.bankDetails,
      supportEmail: event.supportEmail,
      organizationName: event.organization.name,
      companyName: event.organization.companyName,
      companyAddress: event.organization.companyAddress,
      companyCity: event.organization.companyCity,
      companyState: event.organization.companyState,
      companyZipCode: event.organization.companyZipCode,
      companyCountry: event.organization.companyCountry,
      taxId: event.organization.taxId,
      logoPath: event.organization.logo,
      billingCity: city,
      billingCountry: country,
    }).catch((err) =>
      apiLogger.error(
        { err, registrationId: registration.id },
        "registration-service:confirmation-send-failed",
      ),
    );
  }

  return { ok: true, registration };
}

// ── Internal sentinel for transaction rollback ───────────────────────────────

/**
 * Typed sentinel so the outer catch can discriminate domain errors
 * (ALREADY_REGISTERED, SOLD_OUT) from genuine infrastructure failures.
 * Raw `throw new Error("ALREADY_REGISTERED")` would also work but makes
 * the discrimination fragile to message changes.
 */
class RegistrationServiceSentinel extends Error {
  constructor(
    public readonly code: "ALREADY_REGISTERED" | "SOLD_OUT",
    public readonly meta: Record<string, unknown>,
  ) {
    super(code);
    this.name = "RegistrationServiceSentinel";
  }
}
