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
import { AttendanceMode, PaymentStatus, RegistrationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import { sendRegistrationConfirmation } from "@/lib/email";
import { buildEventConfirmationFields } from "@/lib/registration-confirmation";
import { readSponsors } from "@/lib/webinar";
import { needsQrCode } from "@/lib/registration-seat";
import { applyRegistrationTransition, claimEventSeats } from "@/lib/registration-seat-db";
import { resolveRepricing } from "@/lib/registration-repricing";
import { expireOpenCheckoutSessionOnCancel } from "@/lib/checkout-session-cleanup";
import { computeTagDelta, syncRegistrationTagsToSpeakers } from "@/lib/person-tag-sync";
// Leaf constants module (no agent machinery) — the admin-settable
// paymentStatus policy (review H12) shared with the MCP boundary.
import {
  ADMIN_SETTABLE_PAYMENT_STATUSES,
  PAYMENT_STATUS_WRITE_REJECTION,
} from "@/lib/agent/tools/_shared";

// ── Confirmation-email building blocks (shared with the MCP bulk path) ──────

/**
 * Event select carrying everything `sendRegistrationConfirmation` +
 * `buildEventConfirmationFields` need. Exported so the MCP bulk-create path
 * loads the SAME shape instead of hand-copying this list (review M8).
 */
export const CONFIRMATION_EVENT_SELECT = {
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
  settings: true,
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
} as const;
export type ConfirmationEventRow = Prisma.EventGetPayload<{ select: typeof CONFIRMATION_EVENT_SELECT }>;

/**
 * Fire-and-forget confirmation email (quote PDF auto-attaches when price > 0).
 * ONE assembly shared by the single-create path and MCP bulk create — the
 * caller decides WHETHER to send (owes-money / virtual gate); this owns HOW.
 */
export function sendRegistrationConfirmationEmail(args: {
  event: ConfirmationEventRow;
  registration: { id: string; serialId: number | null; qrCode: string | null };
  attendee: {
    email: string;
    additionalEmail?: string | null;
    firstName: string;
    lastName: string;
    title?: string | null;
    organization?: string | null;
    jobTitle?: string | null;
    city?: string | null;
    country?: string | null;
  };
  ticketTypeName: string;
  ticketCurrency?: string | null;
  price: number;
  attendanceMode: AttendanceMode;
  logKey: string;
}): void {
  const { event, registration, attendee } = args;
  sendRegistrationConfirmation({
    ...buildEventConfirmationFields(event),
    to: attendee.email,
    additionalEmail: attendee.additionalEmail ?? null,
    firstName: attendee.firstName,
    lastName: attendee.lastName,
    title: attendee.title ?? null,
    organization: attendee.organization ?? null,
    jobTitle: attendee.jobTitle ?? null,
    attendanceMode: args.attendanceMode,
    ticketType: args.ticketTypeName,
    registrationId: registration.id,
    serialId: registration.serialId,
    qrCode: registration.qrCode || "",
    eventSlug: event.slug,
    ticketPrice: args.price,
    ticketCurrency: args.ticketCurrency ?? undefined,
    billingCity: attendee.city ?? null,
    billingCountry: attendee.country ?? null,
  }).catch((err) =>
    apiLogger.error({ err, registrationId: registration.id }, args.logKey),
  );
}

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
 * FAILED) are excluded because the webhook owns those. INCLUSIVE is
 * admin-settable — sponsor-paid registrations are tagged by the
 * organizer, never by Stripe.
 */
export const MANUAL_PAYMENT_STATUSES = [
  PaymentStatus.UNASSIGNED,
  PaymentStatus.UNPAID,
  PaymentStatus.PAID,
  PaymentStatus.COMPLIMENTARY,
  PaymentStatus.INCLUSIVE,
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

  /**
   * Sponsor attribution — references the id of an entry in the event's
   * `settings.sponsors[]` JSON array. Required when paymentStatus is
   * `INCLUSIVE` (returns `INCLUSIVE_REQUIRES_SPONSOR` otherwise). Validated
   * against the event's sponsor list (returns `SPONSOR_NOT_FOUND` if the
   * id doesn't match any entry). May be set with non-INCLUSIVE statuses
   * too — UI just hides it when irrelevant; deliberately not auto-cleared
   * so reverting to INCLUSIVE later preserves the original attribution.
   */
  sponsorId?: string | null;

  /**
   * "Charge to another account" — id of a reusable org `BillingAccount`
   * (the attendee's hospital, or a pharma/grant covering this HCP). When
   * set, the invoice is addressed to that payer instead of the attendee.
   * ORTHOGONAL to paymentStatus: money is still owed and the registration
   * stays UNPAID/PENDING until the payer settles. Validated to belong to
   * the event's org and be active (`BILLING_ACCOUNT_NOT_FOUND` /
   * `BILLING_ACCOUNT_INACTIVE`). null/omitted = self-pay (unchanged).
   */
  billingAccountId?: string | null;

  /** Optional PO / grant / authorization reference printed on the invoice. */
  payerReference?: string | null;

  /**
   * Per-registration fallback: when true the attendee remains a guarantor
   * for an unpaid third-party invoice (keeps their Pay-Now path and lets
   * finance revert the payer). Defaults false.
   */
  attendeeIsGuarantor?: boolean;

  /**
   * Venue vs online. Only a real choice on HYBRID events; defaults to
   * IN_PERSON. VIRTUAL ⇒ no entry barcode/qrCode is minted, the ticket-type
   * seat count is NOT incremented (virtual is uncapped), and the price
   * resolves to `ticketType.virtualPrice` (flat) when set.
   */
  attendanceMode?: AttendanceMode;

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
  | "EVENT_FULL"
  | "PRICING_TIER_NOT_FOUND"
  | "ALREADY_REGISTERED"
  | "INVALID_PAYMENT_STATUS"
  | "INCLUSIVE_REQUIRES_SPONSOR"
  | "SPONSOR_NOT_FOUND"
  | "BILLING_ACCOUNT_NOT_FOUND"
  | "BILLING_ACCOUNT_INACTIVE"
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

  const billingAccountIdInput = input.billingAccountId ?? null;
  const payerReference = input.payerReference?.trim() || null;
  const attendeeIsGuarantor = input.attendeeIsGuarantor ?? false;
  const attendanceMode: AttendanceMode = input.attendanceMode ?? AttendanceMode.IN_PERSON;
  const isVirtual = attendanceMode === AttendanceMode.VIRTUAL;

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
  // `settings` is included so the sponsorId validation below can resolve
  // against `Event.settings.sponsors[]` without a second query.
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
        settings: true,
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
            virtualPrice: true,
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

  // Effective price for THIS registration: virtual uses the flat
  // `virtualPrice` when set (null ⇒ fall back to the in-person price);
  // in-person uses the base price (pricing-tier resolution below still
  // applies to in-person). Drives the free/paid email gate + the quote.
  // In-person: the pricing-tier price (resolved below) supersedes the base
  // ticket-type price; virtual: virtualPrice (flat) when set. `let` because the
  // tier price is applied after the tier is validated a few lines down.
  let effectiveTicketPrice = ticketType
    ? Number(
        isVirtual && ticketType.virtualPrice != null
          ? ticketType.virtualPrice
          : ticketType.price,
      )
    : 0;

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
  //
  // Deliberately NO `isActive` filter and NO `pricingTier.soldCount`
  // increment/cap here — the admin manual-add path gives organizers full
  // control over which tier to assign, including a CLOSED one (e.g. record
  // a late registrant at the courtesy Early Bird rate). Consequences,
  // accepted by design (organizer decision, May 2026):
  //   • The public self-register path (.../public/events/[slug]/register)
  //     still gates `isActive: true` and atomically bumps + caps
  //     `PricingTier.soldCount`. This service does NOT — it only bumps
  //     `ticketType.soldCount` below. So a manually-assigned tier does not
  //     consume that tier's inventory and is never blocked by its
  //     quantity/closed cap. This is intentional: a courtesy/comp seat must
  //     not burn a real paid Early Bird seat.
  //   • Therefore `PricingTier.soldCount` under-counts vs the actual
  //     registration rows. The "Registrations by Tier" dashboard tile counts
  //     rows (not soldCount) so it stays correct; anything reporting off
  //     `PricingTier.soldCount` directly will diverge — read tier usage from
  //     Registration rows, not the tier counter.
  //   • Tier is now an explicit assignment, not a proxy for "registered
  //     during that sales window" — an Early Bird row may have a createdAt
  //     after Early Bird closed. Finance reconciliation must treat tier as
  //     stated, not derived from registration date / salesEnd.
  let validPricingTierId: string | null = null;
  if (pricingTierId && ticketType) {
    const tier = await db.pricingTier.findFirst({
      where: { id: pricingTierId, ticketTypeId: ticketType.id },
      select: { id: true, price: true },
    });
    if (!tier) {
      return {
        ok: false,
        code: "PRICING_TIER_NOT_FOUND",
        message: "Pricing tier not found for this ticket type",
      };
    }
    validPricingTierId = tier.id;
    // In-person tier price supersedes the base ticket-type price (which is
    // often 0 for tier-priced types). Virtual is flat-priced, tier-independent.
    if (!isVirtual) effectiveTicketPrice = Number(tier.price);
  }

  // Default paymentStatus: UNASSIGNED for paid tickets, COMPLIMENTARY for
  // free (no ticket type OR effective price === 0). Caller override takes
  // priority. Uses the effective price so a free virtual ticket defaults
  // to COMPLIMENTARY even when the in-person price is non-zero.
  const isFree = !ticketType || effectiveTicketPrice === 0;
  const defaultPaymentStatus: ManualPaymentStatus = isFree
    ? PaymentStatus.COMPLIMENTARY
    : PaymentStatus.UNASSIGNED;
  const finalPaymentStatus: ManualPaymentStatus =
    input.paymentStatus ?? defaultPaymentStatus;

  // Sponsor attribution validation. INCLUSIVE means "sponsor paid for
  // this registration out-of-band" so sponsorId is required and must
  // resolve to an entry in Event.settings.sponsors[]. For other payment
  // statuses sponsorId is optional but still validated against the
  // sponsor list when present (so a bad id can't get persisted silently).
  const sponsorId = input.sponsorId ?? null;
  if (finalPaymentStatus === PaymentStatus.INCLUSIVE && !sponsorId) {
    return {
      ok: false,
      code: "INCLUSIVE_REQUIRES_SPONSOR",
      message:
        "paymentStatus=INCLUSIVE requires a sponsorId. Add the sponsor to the event's Sponsors page first, then reference its id.",
    };
  }
  if (sponsorId) {
    const sponsors = readSponsors(event.settings);
    const match = sponsors.find((s) => s.id === sponsorId);
    if (!match) {
      return {
        ok: false,
        code: "SPONSOR_NOT_FOUND",
        message: `Sponsor ${sponsorId} not found in event's sponsor list. Add it via the Sponsors page first.`,
        meta: { availableSponsors: sponsors.map((s) => ({ id: s.id, name: s.name })) },
      };
    }
  }

  // "Charge to another account" — the payer must be a BillingAccount in
  // the same org as the event and must be active. Org-scoped lookup (never
  // trust the id alone — IDOR). Distinct from sponsorId/INCLUSIVE: this
  // does NOT change paymentStatus, only the invoice bill-to party.
  let billingAccountId: string | null = null;
  if (billingAccountIdInput) {
    const ba = await db.billingAccount.findFirst({
      where: { id: billingAccountIdInput, organizationId },
      select: { id: true, isActive: true },
    });
    if (!ba) {
      return {
        ok: false,
        code: "BILLING_ACCOUNT_NOT_FOUND",
        message: `Billing account ${billingAccountIdInput} not found in this organization.`,
      };
    }
    if (!ba.isActive) {
      return {
        ok: false,
        code: "BILLING_ACCOUNT_INACTIVE",
        message: `Billing account ${billingAccountIdInput} is inactive. Reactivate it or pick another payer.`,
      };
    }
    billingAccountId = ba.id;
  }

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
      // VIRTUAL is uncapped: it does NOT consume a physical seat, so we skip
      // the increment AND the sold-out guard (a sold-out venue can still take
      // virtual signups).
      if (ticketType && ticketTypeId && !isVirtual) {
        const updated = await tx.ticketType.updateMany({
          where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
          data: { soldCount: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw new RegistrationServiceSentinel("SOLD_OUT", {});
        }
        // Event-wide cap (Event.maxAttendees): a registration that holds a
        // ticket seat also holds an event seat. Atomic conditional claim —
        // null maxAttendees (the default) never blocks. Same-tx as the
        // ticket claim so a failure rolls both back.
        const eventClaimed = await claimEventSeats(tx, eventId);
        if (!eventClaimed) {
          throw new RegistrationServiceSentinel("EVENT_FULL", {});
        }
      }

      // Entry barcode only for in-person attendees — virtual has nothing to
      // scan at a venue, so qrCode stays null (Postgres allows many nulls in
      // the @unique index). It's minted lazily if an admin later flips the
      // registration to in-person.
      const qrCode = isVirtual ? null : generateBarcode();
      const serialId = await getNextSerialId(tx, eventId);
      // Map the caller identity (already in service input) to the
      // RegistrationCreatedSource enum so the detail sheet can
      // surface "added via dashboard" vs "via MCP agent" at a glance.
      // The "api" source is reserved for the future external public
      // REST API (per src/services/README.md). REST callers from the
      // admin dashboard route → ADMIN_DASHBOARD; MCP → MCP_AGENT.
      const createdSource =
        source === "mcp" ? "MCP_AGENT" : "ADMIN_DASHBOARD";
      return tx.registration.create({
        data: {
          eventId,
          ticketTypeId: ticketTypeId || null,
          pricingTierId: validPricingTierId,
          attendeeId: attendeeRecord.id,
          serialId,
          createdSource,
          status: finalStatus,
          paymentStatus: finalPaymentStatus,
          attendanceMode,
          sponsorId,
          billingAccountId,
          payerReference,
          attendeeIsGuarantor,
          qrCode,
          // Stamp the resolved base price (tier/virtual-aware) so every read
          // surface has an authoritative subtotal — never resolves to 0 for a
          // tier-priced or virtual registration.
          originalPrice: effectiveTicketPrice,
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
      if (err.code === "EVENT_FULL") {
        apiLogger.warn({ msg: "registration:create-event-full", eventId, source }, "registration-service:event-full");
        return {
          ok: false,
          code: "EVENT_FULL",
          message: "This event has reached its maximum number of attendees. Raise the cap in Settings → Registration to admit more.",
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
          ...(sponsorId ? { sponsorId } : {}),
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

  // When to send the confirmation:
  //   • IN_PERSON: only when money is still owed (quote PDF auto-attaches) —
  //     unchanged behavior; free in-person gets no email here.
  //   • VIRTUAL: ALWAYS (when there's a ticket type) — even free — because the
  //     registrant needs the "joining instructions coming" message. The quote
  //     PDF still attaches only if the effective (virtual) price > 0.
  // The barcode block self-skips for virtual (null qrCode); email.ts adds the
  // joining-instructions block when attendanceMode is VIRTUAL.
  const owesMoney =
    effectiveTicketPrice > 0 && OUTSTANDING_PAYMENT_STATUSES.has(finalPaymentStatus);
  if (ticketType && (owesMoney || isVirtual)) {
    sendRegistrationConfirmationEmail({
      event,
      registration,
      attendee: {
        email,
        additionalEmail,
        firstName,
        lastName,
        title: attendeeTitle,
        organization,
        jobTitle,
        city,
        country,
      },
      ticketTypeName: ticketType.name,
      ticketCurrency: ticketType.currency,
      price: effectiveTicketPrice,
      attendanceMode,
      logKey: "registration-service:confirmation-send-failed",
    });
  }

  return { ok: true, registration };
}

// ── Internal sentinel for transaction rollback ───────────────────────────────

/**
 * Typed sentinel so the outer catch can discriminate domain errors
 * (ALREADY_REGISTERED, SOLD_OUT, EVENT_FULL) from genuine infrastructure
 * failures. Raw `throw new Error("ALREADY_REGISTERED")` would also work but
 * makes the discrimination fragile to message changes.
 */
class RegistrationServiceSentinel extends Error {
  constructor(
    public readonly code: "ALREADY_REGISTERED" | "SOLD_OUT" | "EVENT_FULL",
    public readonly meta: Record<string, unknown>,
  ) {
    super(code);
    this.name = "RegistrationServiceSentinel";
  }
}

// ── updateRegistration ───────────────────────────────────────────────────────
//
// Cross-caller audit #5 (July 13, 2026): the update body was hand-mirrored
// between the REST PUT (registrations/[registrationId]/route.ts) and MCP
// `update_registration` (agent/tools/registrations.ts) — the seat/promo
// transition was already shared (`applyRegistrationTransition`) but the
// sponsor invariant, billing-account lookup, change-set assembly, and the
// audit/sync/stats fan-out were two copies with live drift. This is the ONE
// implementation both delegate to. Drift resolved here:
//
//  - M1: the registration lookup binds to the caller's EVENT (`{id, eventId}`),
//    not just the org — a mis-scoped agent call can no longer mutate a sibling
//    event's registration.
//  - M7: the INCLUSIVE↔sponsor invariant is enforced only when the request
//    actually touches paymentStatus/sponsorId (REST's July-7 H2 fix) — MCP
//    used to hard-block ANY edit to a legacy INCLUSIVE-without-sponsor row.
//  - L4: attendee empty-string values collapse to null (REST semantics) —
//    MCP used to persist "" and the Contact sync then skipped the field,
//    leaving the entity blank while the Contact kept the old value.
//  - The audit row now carries the FULL before/after snapshots for both
//    callers (the Activity timeline derives its field-level diffs from them;
//    MCP's slim audit gets richer, REST's stays identical), and the Contact
//    sync uses REST's full field merge (MCP only synced name+email).

/** Attendee patch — `undefined` keeps the current value; empty string clears
 *  clearable fields to null (REST semantics, now on every path). */
export interface UpdateRegistrationAttendeeInput {
  title?: string | null;
  role?: string | null;
  firstName?: string;
  lastName?: string;
  additionalEmail?: string | null;
  organization?: string;
  jobTitle?: string;
  phone?: string;
  photo?: string | null;
  city?: string;
  country?: string;
  bio?: string;
  specialty?: string;
  tags?: string[];
  dietaryReqs?: string;
  associationName?: string | null;
  memberId?: string | null;
  studentId?: string | null;
  studentIdExpiry?: string | null;
  customFields?: Record<string, unknown>;
}

export interface UpdateRegistrationInput {
  eventId: string;
  registrationId: string;
  organizationId: string;
  actorUserId: string;
  source: "rest" | "mcp";
  requestIp?: string | null;
  /** Optimistic-lock token; when absent the write is id-only (warn-logged). */
  expectedUpdatedAt?: string | null;
  status?: RegistrationStatus;
  /** Validated against the admin-settable subset (review H12). */
  paymentStatus?: string;
  sponsorId?: string | null;
  billingAccountId?: string | null;
  payerReference?: string | null;
  attendeeIsGuarantor?: boolean;
  badgeType?: string | null;
  dtcmBarcode?: string | null;
  ticketTypeId?: string;
  /** An id, or null to clear the tier (→ base price); omit to leave unchanged. */
  pricingTierId?: string | null;
  attendanceMode?: AttendanceMode;
  notes?: string;
  taxNumber?: string | null;
  billingFirstName?: string | null;
  billingLastName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingAddress?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZipCode?: string | null;
  billingCountry?: string | null;
  attendee?: UpdateRegistrationAttendeeInput;
}

export type UpdateRegistrationErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "PAYMENT_STATUS_NOT_SETTABLE"
  | "INCLUSIVE_REQUIRES_SPONSOR"
  | "SPONSOR_NOT_FOUND"
  | "BILLING_ACCOUNT_NOT_FOUND"
  | "BILLING_ACCOUNT_INACTIVE"
  | "TICKET_TYPE_NOT_FOUND"
  | "INVALID_STUDENT_ID_EXPIRY"
  | "INVALID_STATUS"
  | "INVALID_ATTENDANCE_MODE"
  | "UNIQUE_CONSTRAINT"
  | "STALE_WRITE"
  | "CAPACITY_EXCEEDED"
  | "EVENT_FULL"
  | "REPRICING_BLOCKED"
  | "UNKNOWN";

export type UpdatedRegistrationRow = Prisma.RegistrationGetPayload<{
  include: {
    attendee: true;
    ticketType: true;
    pricingTier: true;
    payments: {
      select: { id: true; amount: true; currency: true; status: true; createdAt: true };
    };
    accommodation: {
      select: {
        id: true; checkIn: true; checkOut: true; status: true;
        roomType: { select: { name: true; hotel: { select: { name: true } } } };
      };
    };
  };
}>;

export type UpdateRegistrationResult =
  | { ok: true; registration: UpdatedRegistrationRow; qrCodeMinted: boolean }
  | {
      ok: false;
      code: UpdateRegistrationErrorCode;
      message: string;
      meta?: Record<string, unknown>;
      /** For REPRICING_BLOCKED: the sub-code from resolveRepricing (e.g.
       *  TIER_CHANGE_REQUIRES_UNPAID) + its suggested HTTP status. */
      repricingCode?: string;
      httpStatus?: number;
    };

/**
 * Update a registration — statuses, payer, type/tier (repriced), attendance
 * mode, badge/DTCM, billing block, notes, and attendee fields — atomically,
 * with the shared seat/promo transition, the optimistic lock, and the full
 * post-commit fan-out (speaker tag sync, Contact sync, stats, checkout-session
 * expiry on cancel, audit).
 *
 * The caller owns: auth (+ event access via `buildEventAccessWhere` /
 * `getOrgIdSecure`), the EMAIL_IMMUTABLE guard, input shape validation, and
 * response shaping (HTTP mapping / financials block / redaction).
 */
export async function updateRegistration(
  input: UpdateRegistrationInput,
): Promise<UpdateRegistrationResult> {
  const { eventId, registrationId, organizationId, actorUserId, source } = input;

  try {
    // ── Load: registration bound to the caller's event (M1) + event settings ─
    const [existing, event] = await Promise.all([
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        include: { attendee: true },
      }),
      db.event.findFirst({
        where: { id: eventId },
        select: { id: true, settings: true },
      }),
    ]);
    if (!existing || !event) {
      apiLogger.warn({ msg: "registration-update:not-found", registrationId, eventId, source });
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }

    // ── Validate enum-ish inputs (typed callers pass enums; re-check anyway) ─
    const { status, attendanceMode } = input;
    if (status && !Object.values(RegistrationStatus).includes(status)) {
      return { ok: false, code: "INVALID_STATUS", message: `Invalid status "${status}".` };
    }
    if (attendanceMode && !Object.values(AttendanceMode).includes(attendanceMode)) {
      return { ok: false, code: "INVALID_ATTENDANCE_MODE", message: `Invalid attendanceMode "${attendanceMode}".` };
    }
    const paymentStatus = input.paymentStatus as PaymentStatus | undefined;
    if (paymentStatus && !ADMIN_SETTABLE_PAYMENT_STATUSES.has(paymentStatus)) {
      apiLogger.warn({ msg: "registration-update:payment-status-not-settable", registrationId, paymentStatus, source });
      return {
        ok: false,
        code: "PAYMENT_STATUS_NOT_SETTABLE",
        message: `Invalid paymentStatus "${paymentStatus}". Settable values: ${[...ADMIN_SETTABLE_PAYMENT_STATUSES].join(", ")}. ${PAYMENT_STATUS_WRITE_REJECTION}`,
      };
    }

    // ── Sponsor invariant — change-scoped (M7) ───────────────────────────────
    const { sponsorId } = input;
    const effectivePaymentStatus = paymentStatus ?? existing.paymentStatus;
    const effectiveSponsorId = sponsorId === undefined ? existing.sponsorId : sponsorId;
    const touchingSponsorFields = paymentStatus !== undefined || sponsorId !== undefined;
    if (touchingSponsorFields && effectivePaymentStatus === PaymentStatus.INCLUSIVE && !effectiveSponsorId) {
      apiLogger.warn({ msg: "registration-update:inclusive-requires-sponsor", registrationId, source, actorUserId });
      return {
        ok: false,
        code: "INCLUSIVE_REQUIRES_SPONSOR",
        message: "paymentStatus=INCLUSIVE requires a sponsorId. Add the sponsor to the event's Sponsors page first, then reference its id.",
      };
    }
    if (touchingSponsorFields && effectiveSponsorId) {
      const sponsors = readSponsors(event.settings);
      if (!sponsors.find((s) => s.id === effectiveSponsorId)) {
        apiLogger.warn({ msg: "registration-update:sponsor-not-found", registrationId, sponsorId: effectiveSponsorId, source });
        return {
          ok: false,
          code: "SPONSOR_NOT_FOUND",
          message: `Sponsor ${effectiveSponsorId} not found in event's sponsor list.`,
          meta: { availableSponsors: sponsors.map((s) => ({ id: s.id, name: s.name })) },
        };
      }
    }

    // ── Billing account ("charge to another account") ────────────────────────
    const { billingAccountId } = input;
    if (typeof billingAccountId === "string") {
      const ba = await db.billingAccount.findFirst({
        where: { id: billingAccountId, organizationId },
        select: { id: true, isActive: true },
      });
      if (!ba) {
        apiLogger.warn({ msg: "registration-update:billing-account-not-found", registrationId, billingAccountId, source });
        return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND", message: `Billing account ${billingAccountId} not found in this organization.` };
      }
      if (!ba.isActive) {
        apiLogger.warn({ msg: "registration-update:billing-account-inactive", registrationId, billingAccountId, source });
        return { ok: false, code: "BILLING_ACCOUNT_INACTIVE", message: `Billing account ${billingAccountId} is inactive. Reactivate it or pick another payer.` };
      }
    }

    // ── Ticket type (event-scoped — never trust the id alone) ────────────────
    const { ticketTypeId } = input;
    if (ticketTypeId && ticketTypeId !== existing.ticketTypeId) {
      const tt = await db.ticketType.findFirst({
        where: { id: ticketTypeId, eventId },
        select: { id: true },
      });
      if (!tt) {
        apiLogger.warn({ msg: "registration-update:ticket-type-not-found", registrationId, ticketTypeId, source });
        return { ok: false, code: "TICKET_TYPE_NOT_FOUND", message: `Ticket type ${ticketTypeId} not found in this event.` };
      }
    }

    // ── Attendee patch (REST semantics: "" clears, undefined keeps — L4) ─────
    const attendee = input.attendee;
    if (attendee?.studentIdExpiry && isNaN(new Date(attendee.studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "registration-update:invalid-student-id-expiry", registrationId, studentIdExpiry: attendee.studentIdExpiry, source });
      return { ok: false, code: "INVALID_STUDENT_ID_EXPIRY", message: "Invalid student ID expiry date" };
    }
    const attendeeData = attendee
      ? {
          ...(attendee.title !== undefined && { title: (attendee.title || null) as never }),
          ...(attendee.role !== undefined && { role: (attendee.role || null) as never }),
          ...(attendee.firstName && { firstName: attendee.firstName }),
          ...(attendee.lastName && { lastName: attendee.lastName }),
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
          ...(attendee.studentIdExpiry !== undefined && {
            studentIdExpiry: attendee.studentIdExpiry ? new Date(attendee.studentIdExpiry) : null,
          }),
          ...(attendee.customFields && { customFields: attendee.customFields as Prisma.InputJsonValue }),
        }
      : null;

    // ── Repricing (shared resolver — tier and/or type change) ────────────────
    const repricing = await resolveRepricing({
      eventId,
      existing: {
        ticketTypeId: existing.ticketTypeId,
        pricingTierId: existing.pricingTierId,
        paymentStatus: existing.paymentStatus,
        promoCodeId: existing.promoCodeId,
        discountAmount: existing.discountAmount,
      },
      ticketTypeId,
      pricingTierId: input.pricingTierId,
    });
    if (!repricing.ok) {
      apiLogger.warn({ msg: "registration-update:repricing-blocked", registrationId, code: repricing.code, source });
      return {
        ok: false,
        code: "REPRICING_BLOCKED",
        message: repricing.message,
        repricingCode: repricing.code,
        httpStatus: repricing.status,
      };
    }
    const { isChangingType, effectiveTypeId, nextTierId, originalPrice: retierOriginalPrice } = repricing;

    const expectedUpdatedAt = input.expectedUpdatedAt ?? null;
    if (!expectedUpdatedAt) {
      apiLogger.warn({
        msg: "optimistic-lock:missing-expectedUpdatedAt",
        resource: "registration",
        resourceId: registrationId,
        source,
      });
    }

    const effectiveMode = attendanceMode || existing.attendanceMode;
    const qrCodeMinted = needsQrCode(effectiveMode, existing.qrCode);

    // ── The transaction: seat/promo transition + lock-gated writes ───────────
    const registration = await db.$transaction(async (tx) => {
      const effectiveStatus = status || existing.status;
      const seatTierId = nextTierId !== undefined ? nextTierId : existing.pricingTierId;

      // Seat + promo accounting via the SHARED applier (single source of
      // truth): correct counter (tier vs ticket type), VIRTUAL holds no seat,
      // atomic oversell guard (throws CAPACITY_EXCEEDED), promo usedCount
      // moves symmetrically with CANCELLED transitions.
      await applyRegistrationTransition(tx, {
        prev: {
          status: existing.status,
          attendanceMode: existing.attendanceMode,
          ticketTypeId: existing.ticketTypeId,
          pricingTierId: existing.pricingTierId,
          createdSource: existing.createdSource,
        },
        next: {
          status: effectiveStatus,
          attendanceMode: effectiveMode,
          ticketTypeId: effectiveTypeId,
          pricingTierId: seatTierId,
          createdSource: existing.createdSource,
        },
        promoCodeId: existing.promoCodeId,
        eventId,
      });

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
          where: { id: existing.attendeeId },
          data: { registrationType: newTicket.name },
        });
      }

      const changeData: Prisma.RegistrationUncheckedUpdateInput = {
        ...(status && { status }),
        ...(paymentStatus && { paymentStatus }),
        ...(sponsorId !== undefined && { sponsorId }),
        ...(billingAccountId !== undefined && { billingAccountId }),
        ...(input.payerReference !== undefined && { payerReference: input.payerReference || null }),
        ...(input.attendeeIsGuarantor !== undefined && { attendeeIsGuarantor: input.attendeeIsGuarantor }),
        ...(input.badgeType !== undefined && { badgeType: input.badgeType }),
        ...(input.dtcmBarcode !== undefined && { dtcmBarcode: input.dtcmBarcode || null }),
        ...(ticketTypeId && { ticketTypeId }),
        // Persist the resolved tier (undefined = leave unchanged) + re-stamped
        // price. A bare type change nulls the tier (tiers belong to a type) so
        // the stored row stays consistent with where its seat now lives.
        ...(nextTierId !== undefined && { pricingTierId: nextTierId }),
        ...(retierOriginalPrice !== undefined && { originalPrice: retierOriginalPrice }),
        ...(attendanceMode !== undefined && { attendanceMode }),
        // Lazy entry-barcode mint: becoming (or already) in-person with no
        // barcode gets one; virtual keeps null; an existing barcode is kept.
        ...(qrCodeMinted && { qrCode: generateBarcode() }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
        ...(input.taxNumber !== undefined && { taxNumber: input.taxNumber || null }),
        ...(input.billingFirstName !== undefined && { billingFirstName: input.billingFirstName || null }),
        ...(input.billingLastName !== undefined && { billingLastName: input.billingLastName || null }),
        ...(input.billingEmail !== undefined && { billingEmail: input.billingEmail || null }),
        ...(input.billingPhone !== undefined && { billingPhone: input.billingPhone || null }),
        ...(input.billingAddress !== undefined && { billingAddress: input.billingAddress || null }),
        ...(input.billingCity !== undefined && { billingCity: input.billingCity || null }),
        ...(input.billingState !== undefined && { billingState: input.billingState || null }),
        ...(input.billingZipCode !== undefined && { billingZipCode: input.billingZipCode || null }),
        ...(input.billingCountry !== undefined && { billingCountry: input.billingCountry || null }),
        updatedAt: new Date(),
      };

      // Optimistic lock: with expectedUpdatedAt, write only if the row still
      // has that timestamp — a stale write throws + rolls back the seat delta.
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

      // Attendee edits commit atomically with the registration row — AFTER
      // the lock held, so a STALE_WRITE rejection persists nothing (H7).
      if (attendeeData) {
        await tx.attendee.update({
          where: { id: existing.attendeeId },
          data: attendeeData,
        });
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
    }).catch((err) => {
      if (err instanceof Error && ["STALE_WRITE", "REGISTRATION_DISAPPEARED", "CAPACITY_EXCEEDED", "EVENT_FULL"].includes(err.message)) {
        return err.message as "STALE_WRITE" | "REGISTRATION_DISAPPEARED" | "CAPACITY_EXCEEDED" | "EVENT_FULL";
      }
      throw err;
    });

    if (registration === "STALE_WRITE") {
      apiLogger.info({ msg: "registration:stale-write-rejected", registrationId, source });
      return {
        ok: false,
        code: "STALE_WRITE",
        message: "This registration was modified by someone else after you opened it. Reload the latest version and try again.",
      };
    }
    if (registration === "REGISTRATION_DISAPPEARED") {
      return { ok: false, code: "REGISTRATION_NOT_FOUND", message: "Registration not found" };
    }
    if (registration === "CAPACITY_EXCEEDED") {
      apiLogger.warn({ msg: "registration:update-capacity-exceeded", registrationId, source });
      return {
        ok: false,
        code: "CAPACITY_EXCEEDED",
        message: "Cannot reactivate/move this registration — the target registration type is sold out. Increase its quantity or pick another type.",
      };
    }
    if (registration === "EVENT_FULL") {
      apiLogger.warn({ msg: "registration:update-event-full", registrationId, eventId, source });
      return {
        ok: false,
        code: "EVENT_FULL",
        message: "Cannot reactivate this registration — the event has reached its maximum attendees. Raise the cap in Settings → Registration first.",
      };
    }

    // ── Post-commit best-effort fan-out (after the tx held — nothing leaks
    //    into the Speaker facet / Contact store on a rejected write) ──────────
    if (attendee) {
      if (attendee.tags !== undefined) {
        await syncRegistrationTagsToSpeakers(eventId, [
          {
            registrationId,
            email: existing.attendee.email,
            delta: computeTagDelta(existing.attendee.tags, attendee.tags),
          },
        ]);
      }

      // Full-merge Contact sync (REST's shape — MCP used to sync name+email
      // only). `undefined` preserves what the Contact already had.
      const a = existing.attendee;
      await syncToContact({
        organizationId,
        eventId,
        email: a.email,
        additionalEmail: attendee.additionalEmail !== undefined
          ? (attendee.additionalEmail?.trim() || null)
          : a.additionalEmail,
        firstName: attendee.firstName || a.firstName,
        lastName: attendee.lastName || a.lastName,
        title: attendee.title !== undefined ? ((attendee.title || null) as never) : a.title,
        role: attendee.role !== undefined ? ((attendee.role || null) as never) : a.role,
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
        studentIdExpiry: attendee.studentIdExpiry !== undefined
          ? (attendee.studentIdExpiry ? new Date(attendee.studentIdExpiry) : null)
          : a.studentIdExpiry,
      });
    }

    refreshEventStats(eventId);

    // A cancel kills any still-open Stripe payment tab. Fire-and-forget.
    if (status === "CANCELLED" && existing.status !== "CANCELLED") {
      void expireOpenCheckoutSessionOnCancel(registrationId, `registration-update-${source}`);
    }

    // Audit — full before/after snapshots (the Activity timeline derives its
    // field-level diffs from these). Fire-and-forget with a logged catch: a
    // transient insert blip must not turn a committed update into a caller-
    // facing failure (review M13 class).
    db.auditLog
      .create({
        data: {
          eventId,
          userId: actorUserId,
          action: "UPDATE",
          entityType: "Registration",
          entityId: registration.id,
          changes: {
            source,
            before: JSON.parse(JSON.stringify(existing)),
            after: JSON.parse(JSON.stringify(registration)),
            ...(qrCodeMinted && { qrCodeMinted: true }),
            ...(input.requestIp ? { ip: input.requestIp } : {}),
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "registration-update:audit-write-failed", registrationId }));

    return { ok: true, registration, qrCodeMinted };
  } catch (err) {
    // P2002 unique-constraint violation — most likely a duplicate dtcmBarcode.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      const target = (err as { meta?: { target?: string[] } }).meta?.target;
      apiLogger.warn({ msg: "registration-update:unique-constraint", target, registrationId, source });
      return {
        ok: false,
        code: "UNIQUE_CONSTRAINT",
        message: target?.includes("dtcmBarcode")
          ? "This DTCM barcode is already assigned to another registration."
          : "A unique constraint was violated.",
        meta: { target },
      };
    }
    apiLogger.error({ err, msg: "updateRegistration:unknown-failure", registrationId, eventId, source });
    return { ok: false, code: "UNKNOWN", message: "Failed to update registration" };
  }
}
