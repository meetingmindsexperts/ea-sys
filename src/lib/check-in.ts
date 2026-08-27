/**
 * Check-in core — the SINGLE home for the check-in business gates and the
 * commit + fan-out (July 10 review H9).
 *
 * Check-in used to be implemented three times with divergent rules: the two
 * REST handlers (by id + by QR code) carried ~120 near-identical lines, and
 * the MCP `check_in_registration` executor skipped the payment gate entirely
 * (an agent-driven "check everyone in" admitted UNPAID attendees the desk
 * would refuse), wrote no AuditLog row, and its `allowCancelled` override
 * reactivated a CANCELLED registration via a raw update — outside the shared
 * seat/promo transition, so the released promo `usedCount` was never
 * re-claimed. All three callers now share:
 *
 *  - `checkInGate()` — the pure business gate (cancelled / payment / already),
 *    in the exact order the REST handlers enforced.
 *  - `executeCheckIn()` — the row update (optionally wrapped in a transaction
 *    with `applyRegistrationTransition` for the CANCELLED-override path, so a
 *    reactivating check-in re-claims its seat + promo), the CHECK_IN audit
 *    row, stats refresh, and the admin notification.
 *
 * The audit write is fire-and-forget with a logged catch — a transient
 * insert blip (the P2024 pool-timeout class) must not turn an already-
 * committed check-in into a user-facing 500 at the desk (review M13 for
 * these routes).
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { refreshEventStats } from "@/lib/event-stats";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  applyRegistrationTransition,
  type RegistrationTransitionInput,
} from "@/lib/registration-seat-db";

export interface CheckInGateInput {
  status: string;
  paymentStatus: string;
  checkedInAt: Date | null;
  /** `ticketType.price` (Decimal | number | null) — 0 ⇒ free ⇒ complimentary. */
  ticketTypePrice: unknown;
  /** `pricingTier.price` when a tier is set — 0 ⇒ free ⇒ complimentary. */
  pricingTierPrice: unknown;
}

export interface CheckInDenial {
  code: "CANCELLED" | "PAYMENT_REQUIRED" | "ALREADY_CHECKED_IN";
  message: string;
  checkedInAt?: Date;
}

/**
 * The payment-side admission rule — the SINGLE source of truth for "does this
 * registration owe money that blocks entry?", shared by the door gate
 * (`checkInGate`) and badge generation (review H1).
 *
 * Before this existed, the badge route re-implemented the rule as
 * `PAID || complimentary`, so a sponsor-paid (`INCLUSIVE`) or pay-at-desk
 * (`UNASSIGNED`) delegate was ADMITTED by the gate but got NO badge — and if an
 * operator printed only that sponsor block, the empty result read as "these
 * people haven't paid". A badge must exist for everyone the door lets in, so
 * both callers now derive it from here and can never disagree again.
 *
 * Returns true when nothing about payment blocks entry. `CANCELLED` and
 * `VIRTUAL` are separate concerns handled by the callers (the gate's cancelled
 * branch; the badge route's `where`).
 *
 * The badge route derives from this SAME predicate, deliberately: a badge is
 * printed for everyone the door admits and nobody else, so the two cannot drift
 * into handing someone a badge that will not let them in. Tightening here
 * tightens badge printing in step, which is the intent.
 */
export function isComplimentaryRegistration(reg: {
  paymentStatus: string;
  ticketTypePrice: unknown;
  pricingTierPrice: unknown;
}): boolean {
  return (
    reg.paymentStatus === "COMPLIMENTARY" ||
    Number(reg.ticketTypePrice ?? 0) === 0 ||
    (reg.pricingTierPrice != null && Number(reg.pricingTierPrice) === 0)
  );
}

/**
 * Payment statuses that admit someone at the door.
 *
 * An ALLOW-list, and that is the point: a status added to the enum later is
 * excluded until somebody decides otherwise, rather than admitted because
 * nobody remembered to add it to a deny-list. The July-2026 version was the
 * deny-list shape and let UNASSIGNED, FAILED and REFUNDED through by omission.
 */
const ADMISSIBLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
]);

export function isPaymentAdmissible(reg: {
  paymentStatus: string;
  ticketTypePrice: unknown;
  pricingTierPrice: unknown;
  /**
   * Registration status. REQUIRED, not optional, so the compiler names every
   * caller: REFUNDED's verdict depends on it, and a caller that quietly omitted
   * it would admit at the door and print no badge — the exact drift the shared
   * predicate exists to prevent (review H1).
   */
  status: string;
}): boolean {
  // A genuinely free ticket or tier admits regardless of the status string —
  // nothing is owed, so there is nothing for payment to block.
  if (isComplimentaryRegistration(reg)) return true;
  // OWNER DECISION, 2026-08-27: only PAID, COMPLIMENTARY and INCLUSIVE.
  //
  // This REVERSES the July 11 2026 ruling that FAILED and REFUNDED stay
  // admitted ("a failed charge attempt or a goodwill refund doesn't bar the
  // person from the venue"), and additionally excludes UNASSIGNED — the default
  // for an admin-created registration whose payment is still pending, which the
  // old deny-list admitted only because it was not named in it.
  //
  // Checked read-only before shipping: across every upcoming event this newly
  // blocks TWO registrations, one REFUNDED and one UNASSIGNED on a test event.
  //
  // The desk can still admit anyone through `allowPaymentDue` — an explicit,
  // audited override — so this narrows the default, not the desk's authority.
  //
  // REFUNDED IS THE ONE EXCEPTION, and it turns on the registration status
  // rather than the money (owner, 2026-08-27). A refund and a cancellation are
  // different facts: if the organiser gave the money back and LEFT THE
  // REGISTRATION CONFIRMED, that is an affirmative statement that the person is
  // still attending — a sponsor picked up the cost, or it was goodwill. Someone
  // who is not coming gets CANCELLED, which the gate refuses one branch above.
  //
  // FAILED deliberately does NOT get the same treatment: there the money never
  // arrived at all, so the person still owes and CONFIRMED only means nobody has
  // chased them yet.
  //
  // The live case this was asked for: HEMNET 2026 has exactly one CONFIRMED +
  // REFUNDED registration, and they were already through the door.
  if (reg.paymentStatus === "REFUNDED") {
    return reg.status === "CONFIRMED" || reg.status === "CHECKED_IN";
  }

  return ADMISSIBLE_PAYMENT_STATUSES.has(reg.paymentStatus);
}

/**
 * The business gate, identical for every caller:
 *  1. CANCELLED registrations can't check in (unless the caller explicitly
 *     overrides — the override must then reactivate via `executeCheckIn`'s
 *     `reactivation` so seat + promo counters move).
 *  2. Money-outstanding registrations can't check in — unless complimentary
 *     (COMPLIMENTARY status, or a genuinely free ticket/tier), or the caller
 *     passes the explicit desk override (`allowPaymentDue` — review M1: a
 *     registrant whose Stripe payment succeeded but whose webhook is lagging
 *     shows PENDING and used to be un-admittable without recording a manual
 *     payment that later doubled up with the webhook). The override is a
 *     deliberate, audited operator action — callers must log + audit it.
 *  3. Double check-in is rejected with the original timestamp.
 */
export function checkInGate(
  reg: CheckInGateInput,
  opts?: { allowCancelled?: boolean; allowPaymentDue?: boolean },
): CheckInDenial | null {
  if (reg.status === "CANCELLED" && !opts?.allowCancelled) {
    return { code: "CANCELLED", message: "Cannot check in a cancelled registration" };
  }

  if (!isPaymentAdmissible(reg) && !opts?.allowPaymentDue) {
    return { code: "PAYMENT_REQUIRED", message: "Cannot check in — payment required" };
  }

  if (reg.checkedInAt) {
    return { code: "ALREADY_CHECKED_IN", message: "Already checked in", checkedInAt: reg.checkedInAt };
  }

  return null;
}

export interface ExecuteCheckInArgs {
  eventId: string;
  registrationId: string;
  /** Null for actor-less callers (none today — MCP passes ctx.userId). */
  actorUserId: string | null;
  attendeeName: string;
  source: "rest" | "rest-qr" | "mcp";
  /** Extra keys folded into the audit `changes` (ip, qrCode, override flag…). */
  auditExtras?: Record<string, unknown>;
  /**
   * Set for the CANCELLED-override path: the transition input whose `prev` is
   * the cancelled state and `next` the checked-in state. Runs inside one
   * transaction with the row update so the reactivation re-claims the seat
   * (atomic capacity guard — throws `CAPACITY_EXCEEDED`) and the promo
   * `usedCount`. Without it a cancel→override-check-in→cancel sequence
   * released the promo twice.
   */
  reactivation?: RegistrationTransitionInput;
}

/** Commit the check-in + the shared fan-out. Returns the updated row
 *  (attendee + ticketType included — the REST response shape).
 *
 *  Concurrency (review H3): the commit is a CONDITIONAL CLAIM
 *  (`updateMany where { checkedInAt: null }`), not an unconditional update.
 *  `checkInGate` reads `checkedInAt` in memory, so two desk stations (or one
 *  hardware scanner firing into two tabs — the page debounce is per-tab) could
 *  both pass the gate and both write, clobbering the true first-entry time and
 *  emitting duplicate audit rows + admin notifications. Now exactly one write
 *  lands; a loser observes `count === 0`, loads the already-checked-in row, and
 *  returns it idempotently WITHOUT re-firing the fan-out. For the reactivation
 *  path this also gates `applyRegistrationTransition` behind the same claim, so
 *  two concurrent overrides can't double-increment the seat + promo counters
 *  (review M7). */
export async function executeCheckIn(args: ExecuteCheckInArgs) {
  const now = new Date();
  const claimData = { status: "CHECKED_IN" as const, checkedInAt: now };
  const include = { attendee: true, ticketType: true } as const;

  const won = args.reactivation
    ? await tenantTransaction(async (tx) => {
        const claim = await tx.registration.updateMany({
          where: { id: args.registrationId, eventId: args.eventId, checkedInAt: null },
          data: claimData,
        });
        if (claim.count === 0) return false;
        // Only the winner moves the seat + promo counters.
        await applyRegistrationTransition(tx, args.reactivation!);
        return true;
      })
    : (
        await db.registration.updateMany({
          where: { id: args.registrationId, eventId: args.eventId, checkedInAt: null },
          data: claimData,
        })
      ).count > 0;

  if (!won) {
    // A concurrent scan already checked this registration in. Return the
    // existing row idempotently — no duplicate audit row, no second
    // notification, no clobbered timestamp.
    const existing = await db.registration.findUniqueOrThrow({
      where: { id: args.registrationId },
      include,
    });
    apiLogger.info(
      { msg: "check-in:already-claimed-concurrent", eventId: args.eventId, registrationId: args.registrationId },
      "Concurrent check-in lost the claim; returning existing row",
    );
    return existing;
  }

  const updated = await db.registration.findUniqueOrThrow({
    where: { id: args.registrationId },
    include,
  });

  // Fire-and-forget: the check-in has committed — an audit-insert blip must
  // not surface as a failure to the desk (they'd re-scan into "Already
  // checked in" and blame the scanner).
  db.auditLog
    .create({
      data: {
        eventId: args.eventId,
        userId: args.actorUserId,
        action: "CHECK_IN",
        entityType: "Registration",
        entityId: args.registrationId,
        changes: {
          checkedInAt: updated.checkedInAt,
          attendeeName: args.attendeeName,
          source: args.source,
          ...args.auditExtras,
        },
      },
    })
    .catch((err) =>
      apiLogger.warn({
        err,
        msg: "check-in:audit-log-failed",
        eventId: args.eventId,
        registrationId: args.registrationId,
      }),
    );

  refreshEventStats(args.eventId);

  notifyEventAdmins(args.eventId, {
    type: "CHECK_IN",
    title: "Attendee Checked In",
    message: `${args.attendeeName} checked in`,
    link: `/events/${args.eventId}/check-in`,
  }).catch((err) =>
    apiLogger.error({ err, msg: "Failed to send check-in notification" }),
  );

  return updated;
}

export interface UndoCheckInArgs {
  eventId: string;
  registrationId: string;
  actorUserId: string | null;
  attendeeName: string;
  source: "rest" | "mcp";
  auditExtras?: Record<string, unknown>;
}

export type UndoCheckInResult =
  | { ok: true; registration: Awaited<ReturnType<typeof executeCheckIn>> }
  | { ok: false; code: "NOT_CHECKED_IN"; message: string };

/**
 * Undo a check-in (review H2). Before this existed there was NO undo at all —
 * `checkedInAt: null` was never written anywhere in the codebase. The only
 * affordance was flipping status back to CONFIRMED via the general
 * registration PUT, which left `checkedInAt` set. The gate then refused that
 * attendee FOREVER with ALREADY_CHECKED_IN, while the attendance tile (keyed on
 * status) showed them as not in — an unrecoverable contradiction at the door.
 *
 * This clears `status` AND `checkedInAt` together, atomically, via a
 * conditional claim so it is idempotent and two concurrent undos resolve to
 * one. It reverts to CONFIRMED (the normal pre-check-in state) and deliberately
 * does NOT touch the seat/promo counters — undo un-checks-in, it does not
 * cancel, so the registration stays a valid active seat. No admin notification
 * (a quiet desk correction), but it is audited.
 */
export async function undoCheckIn(args: UndoCheckInArgs): Promise<UndoCheckInResult> {
  const include = { attendee: true, ticketType: true } as const;

  const claim = await db.registration.updateMany({
    where: { id: args.registrationId, eventId: args.eventId, checkedInAt: { not: null } },
    data: { status: "CONFIRMED", checkedInAt: null },
  });
  if (claim.count === 0) {
    // Either not checked in, wrong event, or a concurrent undo already won.
    apiLogger.warn(
      { msg: "check-in:undo-not-checked-in", eventId: args.eventId, registrationId: args.registrationId, source: args.source },
      "Undo check-in: registration was not checked in",
    );
    return { ok: false, code: "NOT_CHECKED_IN", message: "This registration is not checked in." };
  }

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: args.registrationId },
    include,
  });

  apiLogger.info(
    { msg: "check-in:undone", eventId: args.eventId, registrationId: args.registrationId, source: args.source },
    "Check-in undone",
  );

  db.auditLog
    .create({
      data: {
        eventId: args.eventId,
        userId: args.actorUserId,
        action: "CHECK_IN_UNDO",
        entityType: "Registration",
        entityId: args.registrationId,
        changes: {
          attendeeName: args.attendeeName,
          source: args.source,
          ...args.auditExtras,
        },
      },
    })
    .catch((err) =>
      apiLogger.warn({
        err,
        msg: "check-in:undo-audit-log-failed",
        eventId: args.eventId,
        registrationId: args.registrationId,
      }),
    );

  refreshEventStats(args.eventId);

  return { ok: true, registration };
}
