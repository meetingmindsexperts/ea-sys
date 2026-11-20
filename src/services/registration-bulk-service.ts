/**
 * The general actions on ticked registrations (owner, Nov 20, 2026; plan
 * docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md §4, step 3): set the payment
 * status, set the badge type, cancel.
 *
 * NO RULE OF ITS OWN ABOUT WHAT A CHANGE DOES. Each row's change IS the single
 * registration's: `updateRegistration` for the payment status and the badge
 * type (its checks, its seat and promo transition, its audit row, its syncs),
 * `cancelRegistration` for a cancel (the Cancel button's own path). What those
 * refuse for one registration is skipped here and named.
 *
 * WHAT IT ADDS IS ONE CAUTION: money never disappears in bulk. A row with a
 * payment, an invoice or a refund on it, a sponsor-paid row and a group
 * member's row are NOT given a new payment status or cancelled here. They are
 * skipped with the reason, and the person decides on that registration's own
 * page, where the refund and the credit note are. A badge type is harmless
 * and is set on every row. The money is looked at AGAIN immediately before
 * each row's change, not once for the whole run: a desk payment taken while a
 * long run is under way must be seen (review of 345400df).
 *
 * "MAKE PRESENTERS" IS ONE PRESET OF THIS, with the two things that are true
 * of a presenter whichever screen asks (found by running the whole journey,
 * Nov 20, 2026: the Abstracts side had them and the Registrations side did
 * not, so ticking everyone under "Abstract accepted" turned an invited
 * speaker's Faculty badge into Presenter):
 *   - a registration on the event's FACULTY type is an invited speaker's or a
 *     committee member's: already free, badge Faculty, left exactly as it is;
 *   - a badge type someone set by hand (Exhibitor, Committee) is kept: the
 *     registration is made Complimentary and the badge is named, not replaced.
 * Setting a badge type or a payment status by hand, without the preset, does
 * exactly what was asked on every row.
 *
 * Works for a bounded time per call and answers `remaining`; the caller sends
 * those again. Errors as values; never imports next/server.
 */
import { PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { PRESENTER_BADGE_TYPE } from "@/lib/author-facts";
import { refreshEventStats } from "@/lib/event-stats";
import { cancelRegistration } from "@/services/payment-service";
import { updateRegistration } from "@/services/registration-service";

export const MAX_BULK_REGISTRATION_UPDATES = 500;

/**
 * The payment statuses that may be set on many rows at once: free, or back to
 * owing. Never Paid (a payment is recorded, one registration at a time) and
 * never Inclusive (it needs its sponsor).
 */
export const BULK_PAYMENT_STATUSES = [PaymentStatus.COMPLIMENTARY, PaymentStatus.UNPAID, PaymentStatus.UNASSIGNED] as const;
export type BulkPaymentStatus = (typeof BULK_PAYMENT_STATUSES)[number];

/** Statuses that mean money has moved or is moving: never changed in bulk. */
const MONEY_STATUSES: readonly string[] = [PaymentStatus.PAID, PaymentStatus.PENDING, PaymentStatus.REFUNDED, PaymentStatus.FAILED];

export interface BulkUpdateRegistrationsInput {
  eventId: string;
  organizationId: string;
  actorUserId: string;
  registrationIds: string[];
  paymentStatus?: BulkPaymentStatus;
  /** A badge type to set; an empty string clears it. Omit to leave it. */
  badgeType?: string;
  cancel?: boolean;
  /** Complimentary with a Presenter badge, by the presenter rules in the header. Not with the fields above. */
  preset?: "presenters";
  source: "rest" | "mcp" | "agent";
  requestIp?: string | null;
  /** How long one call may work (ms). */
  budgetMs?: number;
}

export type BulkRegistrationSkipCode =
  | "NOT_FOUND"
  | "CANCELLED"
  | "HAS_MONEY"
  | "SPONSOR_PAID"
  | "GROUP_MEMBER"
  /** A card payment may be in progress in an open checkout. */
  | "CHECKOUT_OPEN"
  /** The presenters preset: on the Faculty type, so left exactly as it is. */
  | "FACULTY"
  /** The presenters preset: a badge type set by hand was kept. */
  | "BADGE_KEPT"
  /** The single change refused it; `message` carries its own words. */
  | "REFUSED";

export interface BulkRegistrationSkip {
  registrationId: string;
  /** Which part was not done; a row can have its badge set and its payment status skipped. */
  part: "paymentStatus" | "badgeType" | "cancel" | "all";
  code: BulkRegistrationSkipCode;
  message: string;
  /** For BADGE_KEPT: the badge type that was kept. */
  badgeType?: string;
}

export type BulkUpdateRegistrationsResult =
  | { ok: true; changed: string[]; unchanged: string[]; skipped: BulkRegistrationSkip[]; remaining: string[] }
  | { ok: false; code: "NOTHING_TO_CHANGE" | "TOO_MANY" | "UNKNOWN"; message: string };

/** What is read of a registration to decide; `invoices` counts the ones not cancelled. */
const ROW_SELECT = {
  id: true,
  status: true,
  paymentStatus: true,
  badgeType: true,
  groupId: true,
  refundedAmount: true,
  stripeCheckoutSessionId: true,
  updatedAt: true,
  ticketType: { select: { isFaculty: true } },
  _count: { select: { payments: true, invoices: { where: { status: { not: "CANCELLED" } } } } },
} as const;

type Row = {
  id: string;
  status: string;
  paymentStatus: string;
  badgeType: string | null;
  groupId: string | null;
  refundedAmount: unknown;
  stripeCheckoutSessionId: string | null;
  updatedAt: Date;
  ticketType: { isFaculty: boolean } | null;
  _count: { payments: number; invoices: number };
};

/** Why a row's payment status (or the row itself, for a cancel) is not touched in bulk; null when it may be. */
function moneyRefusal(row: Row): { code: BulkRegistrationSkipCode; message: string } | null {
  if (row.paymentStatus === PaymentStatus.INCLUSIVE) {
    return { code: "SPONSOR_PAID", message: "Paid by a sponsor. It is left as it is." };
  }
  if (row.groupId) {
    return { code: "GROUP_MEMBER", message: "Part of a group registration, which is paid as a group. Change it on the registration's own page." };
  }
  const hasMoney =
    MONEY_STATUSES.includes(row.paymentStatus) || row._count.payments > 0 || row._count.invoices > 0 || Number(row.refundedAmount ?? 0) > 0;
  if (hasMoney) {
    return { code: "HAS_MONEY", message: "Has a payment, an invoice or a refund on it. Change it on the registration's own page, where the refund is decided." };
  }
  return null;
}

/**
 * An open card checkout on a row that still owes: someone may be paying the
 * old price this minute (promo-settlement.ts treats it the same way). Its
 * payment status is left alone; a cancel closes the checkout itself.
 */
function checkoutRefusal(row: Row): { code: BulkRegistrationSkipCode; message: string } | null {
  if (!row.stripeCheckoutSessionId) return null;
  return { code: "CHECKOUT_OPEN", message: "A card payment may be in progress. Change it on the registration's own page." };
}

type RowOutcome = { changed: boolean; skips: BulkRegistrationSkip[] };

/** One registration: what applies to it, through the single registration's own paths. */
async function bulkUpdateOne(input: BulkUpdateRegistrationsInput, registrationId: string): Promise<RowOutcome> {
  const skips: BulkRegistrationSkip[] = [];
  const skip = (part: BulkRegistrationSkip["part"], refusal: { code: BulkRegistrationSkipCode; message: string; badgeType?: string }) =>
    skips.push({ registrationId, part, ...refusal });

  // Read NOW, immediately before this row's change, and scoped to the event
  // (an id from elsewhere is simply not found).
  const row: Row | null = await db.registration.findFirst({ where: { id: registrationId, eventId: input.eventId }, select: ROW_SELECT });
  if (!row) {
    skip("all", { code: "NOT_FOUND", message: "This registration is not on the event." });
    return { changed: false, skips };
  }

  if (row.status === "CANCELLED") {
    // Already cancelled is what a cancel asks for; nothing else is set on a cancelled row.
    if (!input.cancel) skip("all", { code: "CANCELLED", message: "This registration is cancelled." });
    return { changed: false, skips };
  }

  const money = moneyRefusal(row);

  if (input.cancel) {
    if (money) {
      skip("cancel", money);
      return { changed: false, skips };
    }
    const result = await cancelRegistration({
      registrationId: row.id,
      eventId: input.eventId,
      organizationId: input.organizationId,
      refund: false,
      source: input.source === "rest" ? "rest" : "mcp",
      issuedByUserId: input.actorUserId,
      skipStatsRefresh: true,
    });
    if (!result.ok) skip("cancel", { code: "REFUSED", message: result.message });
    return { changed: result.ok, skips };
  }

  const presenters = input.preset === "presenters";
  if (presenters && row.ticketType?.isFaculty) {
    skip("all", { code: "FACULTY", message: "Invited faculty: already free, with a Faculty badge. Left as it is." });
    return { changed: false, skips };
  }
  const paymentTarget = presenters ? PaymentStatus.COMPLIMENTARY : input.paymentStatus;
  const badgeTarget = presenters ? PRESENTER_BADGE_TYPE : input.badgeType;
  const ownBadge = (row.badgeType ?? "").trim();
  // The preset never replaces a badge type someone set by hand.
  const badgeKept = presenters && ownBadge !== "" && ownBadge !== PRESENTER_BADGE_TYPE;
  if (badgeKept) skip("badgeType", { code: "BADGE_KEPT", message: `Its badge type was kept: ${ownBadge}.`, badgeType: ownBadge });

  const wantsPayment = paymentTarget !== undefined && row.paymentStatus !== paymentTarget;
  const wantsBadge = !badgeKept && badgeTarget !== undefined && (row.badgeType ?? "") !== badgeTarget;
  const paymentRefusal = money ?? checkoutRefusal(row);
  if (wantsPayment && paymentRefusal) skip("paymentStatus", paymentRefusal);
  const setPayment = wantsPayment && !paymentRefusal;
  if (!setPayment && !wantsBadge) return { changed: false, skips };

  const result = await updateRegistration({
    eventId: input.eventId,
    registrationId: row.id,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    source: input.source,
    requestIp: input.requestIp ?? null,
    // Someone who edited this registration since the list was read wins: the row is skipped, not overwritten.
    expectedUpdatedAt: row.updatedAt.toISOString(),
    skipStatsRefresh: true,
    ...(setPayment && { paymentStatus: paymentTarget }),
    ...(wantsBadge && { badgeType: badgeTarget === "" ? null : badgeTarget }),
  });
  if (!result.ok) {
    // One write carried both parts, so neither was done.
    const onePart = setPayment ? "paymentStatus" : "badgeType";
    skip(setPayment && wantsBadge ? "all" : onePart, { code: "REFUSED", message: result.message });
    return { changed: false, skips };
  }
  return { changed: true, skips };
}

export async function bulkUpdateRegistrations(input: BulkUpdateRegistrationsInput): Promise<BulkUpdateRegistrationsResult> {
  const { eventId } = input;
  const refuse = (code: "NOTHING_TO_CHANGE" | "TOO_MANY" | "UNKNOWN", message: string): BulkUpdateRegistrationsResult => {
    apiLogger.warn({ msg: "registration-bulk-update:rejected", eventId, code, userId: input.actorUserId });
    return { ok: false, code, message };
  };
  try {
    const ids = [...new Set(input.registrationIds)];
    const nothingAsked = input.paymentStatus === undefined && input.badgeType === undefined && !input.cancel && !input.preset;
    if (ids.length === 0 || nothingAsked) return refuse("NOTHING_TO_CHANGE", "Choose registrations and what to change.");
    if (ids.length > MAX_BULK_REGISTRATION_UPDATES) {
      return refuse("TOO_MANY", `Up to ${MAX_BULK_REGISTRATION_UPDATES} registrations at a time.`);
    }

    const changed: string[] = [];
    const unchanged: string[] = [];
    const skipped: BulkRegistrationSkip[] = [];
    const remaining: string[] = [];
    const deadline = Date.now() + (input.budgetMs ?? 25_000);

    for (const [index, id] of ids.entries()) {
      // The first is always attempted, so a call can never do nothing.
      if (index > 0 && Date.now() > deadline) {
        remaining.push(...ids.slice(index));
        break;
      }
      try {
        const outcome = await bulkUpdateOne(input, id);
        skipped.push(...outcome.skips);
        if (outcome.changed) changed.push(id);
        else if (outcome.skips.length === 0) unchanged.push(id);
      } catch (err) {
        // One row failing is named and the rest carry on: the tally is never lost.
        apiLogger.error({ err, msg: "registration-bulk-update:row-failed", eventId, registrationId: id });
        skipped.push({ registrationId: id, part: "all", code: "REFUSED", message: "Something went wrong with this one." });
      }
    }

    if (changed.length > 0) refreshEventStats(eventId);
    if (skipped.length > 0) {
      apiLogger.warn({
        msg: "registration-bulk-update:some-skipped",
        eventId,
        userId: input.actorUserId,
        skipped: skipped.map((s) => ({ registrationId: s.registrationId, part: s.part, code: s.code })),
      });
    }
    apiLogger.info({
      msg: "registration-bulk-update:done",
      eventId,
      userId: input.actorUserId,
      paymentStatus: input.paymentStatus ?? null,
      badgeType: input.badgeType ?? null,
      cancel: input.cancel === true,
      preset: input.preset ?? null,
      changed: changed.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      remaining: remaining.length,
    });
    return { ok: true, changed, unchanged, skipped, remaining };
  } catch (err) {
    apiLogger.error({ err, msg: "registration-bulk-update:failed", eventId });
    return { ok: false, code: "UNKNOWN", message: "The change could not be made." };
  }
}
