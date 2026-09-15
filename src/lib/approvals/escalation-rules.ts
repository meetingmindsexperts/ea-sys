/**
 * When an approval step nobody has decided moves on (spec §8.3), as pure
 * functions over plain values, so the timeline is a table in a unit test
 * rather than a behaviour of a cron job.
 *
 * The timeline, counted from the step's creation:
 *   - on creation: the assignee is emailed (the worker's assignment pass);
 *   - at 24 hours (the step's `dueAt`): one reminder;
 *   - at 48 hours: the step gains a DELEGATE, who can decide it beside the
 *     assignee: the assignee's configured delegate when that person can take
 *     this amount, otherwise the next tier;
 *   - at 96 hours: the step is ESCALATED: closed as skipped, and a new step
 *     opens for the next tier.
 *
 * A step that cannot move (its assignee is the final approver, or nobody sits
 * above them) is reminded every 24 hours instead, because otherwise it would
 * wait in silence: the spec's "a request waiting on Medhat is reminded daily;
 * there is no standby for him".
 *
 * An assignee who has lost the authority to decide (grant removed, ceiling
 * lowered below the amount, account deactivated) is escalated on the next
 * tick rather than after four days: waiting on someone who cannot decide
 * helps nobody.
 *
 * Client-safe: no db, no Node imports.
 */

export const REMIND_AFTER_HOURS = 24;
export const DELEGATE_AFTER_HOURS = 48;
export const ESCALATE_AFTER_HOURS = 96;
export const REPEAT_REMINDER_HOURS = 24;
/** Assignment and decision emails are sent only for rows newer than this, so nothing old is mailed after an outage. */
export const NOTIFY_WINDOW_DAYS = 7;

const HOUR_MS = 3_600_000;

/** One person who may approve, as the rules need them. */
export interface ApproverHolder {
  id: string;
  /** `Infinity` for the final approver; `0` for someone with no authority. */
  ceilingAed: number;
  /** The person this approver has named to stand in after 48 hours, or null. */
  delegateUserId: string | null;
}

function covers(h: ApproverHolder, amountAed: number, requireFinal: boolean): boolean {
  if (requireFinal) return h.ceilingAed === Number.POSITIVE_INFINITY;
  return Number.isFinite(amountAed) && amountAed <= h.ceilingAed;
}

/**
 * The next tier above the current approver: the lowest ceiling that covers the
 * amount and sits strictly above theirs, never the requester and never the
 * current approver. An over-budget exception only ever moves to another final
 * approver. Deterministic on a tie.
 */
export function pickNextTier(input: {
  holders: ApproverHolder[];
  amountAed: number;
  requesterUserId: string;
  currentUserId: string;
  currentCeilingAed: number;
  requireFinal: boolean;
}): string | null {
  const floor = Number.isNaN(input.currentCeilingAed) ? 0 : input.currentCeilingAed;
  const candidates = input.holders
    .filter((h) => h.id !== input.requesterUserId && h.id !== input.currentUserId)
    .filter((h) => covers(h, input.amountAed, input.requireFinal))
    .filter((h) => h.ceilingAed > floor)
    // Infinity minus Infinity is NaN, which is falsy, so a tie between two
    // final approvers falls through to the id.
    .sort((a, b) => a.ceilingAed - b.ceilingAed || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

/**
 * Who stands in at 48 hours: the assignee's configured delegate when that
 * person can decide this amount and did not raise it, else the next tier.
 */
export function pickDelegate(input: {
  holders: ApproverHolder[];
  assigneeUserId: string;
  amountAed: number;
  requesterUserId: string;
  requireFinal: boolean;
}): { userId: string; via: "configured" | "next-tier" } | null {
  const assignee = input.holders.find((h) => h.id === input.assigneeUserId);
  const configured = assignee?.delegateUserId ?? null;
  if (configured && configured !== input.requesterUserId && configured !== input.assigneeUserId) {
    const holder = input.holders.find((h) => h.id === configured);
    if (holder && covers(holder, input.amountAed, input.requireFinal)) return { userId: configured, via: "configured" };
  }
  const next = pickNextTier({
    holders: input.holders,
    amountAed: input.amountAed,
    requesterUserId: input.requesterUserId,
    currentUserId: input.assigneeUserId,
    currentCeilingAed: assignee?.ceilingAed ?? 0,
    requireFinal: input.requireFinal,
  });
  return next ? { userId: next, via: "next-tier" } : null;
}

export type StepAction =
  | { kind: "none" }
  | { kind: "remind"; repeat: boolean }
  | { kind: "delegate"; toUserId: string; via: "configured" | "next-tier" }
  | { kind: "escalate"; toUserId: string; reason: "no-decision" | "assignee-lost-authority" };

export interface StepSnapshot {
  createdAt: Date;
  dueAt: Date;
  remindedAt: Date | null;
  delegateUserId: string | null;
}

/** The one thing to do with a pending step on this tick, most consequential first. */
export function planStepAction(
  step: StepSnapshot,
  ctx: {
    now: Date;
    /** The assignee still holds authority for this amount (and for an exception, is a final approver). */
    assigneeCanDecide: boolean;
    assigneeIsFinal: boolean;
    nextTierUserId: string | null;
    delegate: { userId: string; via: "configured" | "next-tier" } | null;
  },
): StepAction {
  const now = ctx.now.getTime();
  const age = now - step.createdAt.getTime();
  if (!ctx.assigneeCanDecide && ctx.nextTierUserId) {
    return { kind: "escalate", toUserId: ctx.nextTierUserId, reason: "assignee-lost-authority" };
  }
  const canMove = !ctx.assigneeIsFinal && ctx.nextTierUserId !== null;
  if (canMove && age >= ESCALATE_AFTER_HOURS * HOUR_MS) {
    return { kind: "escalate", toUserId: ctx.nextTierUserId!, reason: "no-decision" };
  }
  if (canMove && age >= DELEGATE_AFTER_HOURS * HOUR_MS && step.delegateUserId === null && ctx.delegate) {
    return { kind: "delegate", toUserId: ctx.delegate.userId, via: ctx.delegate.via };
  }
  if (now < step.dueAt.getTime()) return { kind: "none" };
  if (step.remindedAt === null) return { kind: "remind", repeat: false };
  if (!canMove && now - step.remindedAt.getTime() >= REPEAT_REMINDER_HOURS * HOUR_MS) return { kind: "remind", repeat: true };
  return { kind: "none" };
}

export function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / HOUR_MS);
}
