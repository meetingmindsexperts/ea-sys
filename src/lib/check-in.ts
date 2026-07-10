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
import { db } from "@/lib/db";
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
 * The business gate, identical for every caller:
 *  1. CANCELLED registrations can't check in (unless the caller explicitly
 *     overrides — the override must then reactivate via `executeCheckIn`'s
 *     `reactivation` so seat + promo counters move).
 *  2. Money-outstanding registrations can't check in — unless complimentary
 *     (COMPLIMENTARY status, or a genuinely free ticket/tier).
 *  3. Double check-in is rejected with the original timestamp.
 */
export function checkInGate(
  reg: CheckInGateInput,
  opts?: { allowCancelled?: boolean },
): CheckInDenial | null {
  if (reg.status === "CANCELLED" && !opts?.allowCancelled) {
    return { code: "CANCELLED", message: "Cannot check in a cancelled registration" };
  }

  const isComplimentary =
    reg.paymentStatus === "COMPLIMENTARY" ||
    Number(reg.ticketTypePrice ?? 0) === 0 ||
    (reg.pricingTierPrice != null && Number(reg.pricingTierPrice) === 0);
  if (!isComplimentary && (reg.paymentStatus === "UNPAID" || reg.paymentStatus === "PENDING")) {
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
 *  (attendee + ticketType included — the REST response shape). */
export async function executeCheckIn(args: ExecuteCheckInArgs) {
  const data = { status: "CHECKED_IN" as const, checkedInAt: new Date() };
  const include = { attendee: true, ticketType: true } as const;

  const updated = args.reactivation
    ? await db.$transaction(async (tx) => {
        await applyRegistrationTransition(tx, args.reactivation!);
        return tx.registration.update({ where: { id: args.registrationId }, data, include });
      })
    : await db.registration.update({ where: { id: args.registrationId }, data, include });

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
