/**
 * The approval timeline (spec §8.3) as a table: reminder at 24 hours, a
 * delegate at 48, escalation to the next tier at 96, daily reminders for a
 * step that cannot move, and an immediate escalation when the assignee has
 * lost the authority to decide. The delegate and next-tier pickers never
 * choose the requester, never the current approver, and keep an over-budget
 * exception with final approvers.
 */
import { describe, it, expect } from "vitest";
import { hoursBetween, pickDelegate, pickNextTier, planStepAction, type ApproverHolder } from "@/lib/approvals/escalation-rules";

const H = 3_600_000;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);

const LINA: ApproverHolder = { id: "lina", ceilingAed: 1_000_000, delegateUserId: null };
const SARA: ApproverHolder = { id: "sara", ceilingAed: 2_000_000, delegateUserId: null };
const MEDHAT: ApproverHolder = { id: "medhat", ceilingAed: Number.POSITIVE_INFINITY, delegateUserId: null };
const KAREEM: ApproverHolder = { id: "kareem", ceilingAed: Number.POSITIVE_INFINITY, delegateUserId: null };

function step(ageHours: number, over: Partial<{ remindedAt: Date | null; delegateUserId: string | null }> = {}) {
  const createdAt = ago(ageHours);
  return { createdAt, dueAt: new Date(createdAt.getTime() + 24 * H), remindedAt: null, delegateUserId: null, ...over };
}
const banded = { now: NOW, assigneeCanDecide: true, assigneeIsFinal: false, nextTierUserId: "medhat", delegate: { userId: "medhat", via: "next-tier" as const } };
const final = { now: NOW, assigneeCanDecide: true, assigneeIsFinal: true, nextTierUserId: null, delegate: null };

describe("planStepAction: a banded approver's step", () => {
  it("does nothing before 24 hours", () => {
    expect(planStepAction(step(23.9), banded)).toEqual({ kind: "none" });
  });
  it("reminds once at 24 hours, and not again before 48", () => {
    expect(planStepAction(step(24), banded)).toEqual({ kind: "remind", repeat: false });
    expect(planStepAction(step(40, { remindedAt: ago(16) }), banded)).toEqual({ kind: "none" });
  });
  it("names a delegate at 48 hours, once", () => {
    expect(planStepAction(step(48, { remindedAt: ago(24) }), banded)).toEqual({ kind: "delegate", toUserId: "medhat", via: "next-tier" });
    expect(planStepAction(step(60, { remindedAt: ago(12), delegateUserId: "medhat" }), banded)).toEqual({ kind: "none" });
  });
  it("delegates rather than reminding when a late tick first sees a 50-hour step", () => {
    expect(planStepAction(step(50), banded)).toMatchObject({ kind: "delegate" });
  });
  it("escalates at 96 hours, whether or not a delegate was named", () => {
    expect(planStepAction(step(96, { remindedAt: ago(72), delegateUserId: "medhat" }), banded)).toEqual({ kind: "escalate", toUserId: "medhat", reason: "no-decision" });
    expect(planStepAction(step(120), banded)).toMatchObject({ kind: "escalate", reason: "no-decision" });
  });
  it("escalates at once when the assignee can no longer decide", () => {
    expect(planStepAction(step(1), { ...banded, assigneeCanDecide: false })).toEqual({ kind: "escalate", toUserId: "medhat", reason: "assignee-lost-authority" });
  });
});

describe("planStepAction: a step that cannot move", () => {
  it("the final approver is reminded every 24 hours and never delegated or escalated", () => {
    expect(planStepAction(step(24), final)).toEqual({ kind: "remind", repeat: false });
    expect(planStepAction(step(47, { remindedAt: ago(23) }), final)).toEqual({ kind: "none" });
    expect(planStepAction(step(48, { remindedAt: ago(24) }), final)).toEqual({ kind: "remind", repeat: true });
    expect(planStepAction(step(500, { remindedAt: ago(25) }), final)).toEqual({ kind: "remind", repeat: true });
  });
  it("a banded approver with nobody above is reminded daily too", () => {
    const stuck = { ...banded, nextTierUserId: null, delegate: null };
    expect(planStepAction(step(100, { remindedAt: ago(24) }), stuck)).toEqual({ kind: "remind", repeat: true });
  });
  it("an assignee who lost authority with nobody above keeps being reminded rather than escalated to no one", () => {
    const stuck = { ...banded, assigneeCanDecide: false, nextTierUserId: null, delegate: null };
    expect(planStepAction(step(30), stuck)).toEqual({ kind: "remind", repeat: false });
  });
});

describe("pickNextTier", () => {
  const base = { amountAed: 500_000, requesterUserId: "owner", requireFinal: false };
  it("is the lowest ceiling above the current approver that covers the amount", () => {
    expect(pickNextTier({ ...base, holders: [LINA, SARA, MEDHAT], currentUserId: "lina", currentCeilingAed: 1_000_000 })).toBe("sara");
    expect(pickNextTier({ ...base, holders: [LINA, MEDHAT], currentUserId: "lina", currentCeilingAed: 1_000_000 })).toBe("medhat");
  });
  it("never the requester, never the current approver", () => {
    expect(pickNextTier({ ...base, requesterUserId: "sara", holders: [LINA, SARA, MEDHAT], currentUserId: "lina", currentCeilingAed: 1_000_000 })).toBe("medhat");
    expect(pickNextTier({ ...base, requesterUserId: "medhat", holders: [LINA, MEDHAT], currentUserId: "lina", currentCeilingAed: 1_000_000 })).toBeNull();
  });
  it("the final approver has nobody above, not even another final approver", () => {
    expect(pickNextTier({ ...base, holders: [LINA, MEDHAT, KAREEM], currentUserId: "medhat", currentCeilingAed: Number.POSITIVE_INFINITY })).toBeNull();
  });
  it("an exception only moves to a final approver", () => {
    expect(pickNextTier({ ...base, requireFinal: true, holders: [LINA, SARA, MEDHAT], currentUserId: "lina", currentCeilingAed: 1_000_000 })).toBe("medhat");
  });
  it("an assignee who lost their grant counts from zero", () => {
    expect(pickNextTier({ ...base, holders: [SARA, MEDHAT], currentUserId: "lina", currentCeilingAed: 0 })).toBe("sara");
    expect(pickNextTier({ ...base, holders: [SARA, MEDHAT], currentUserId: "lina", currentCeilingAed: Number.NaN })).toBe("sara");
  });
});

describe("pickDelegate", () => {
  const base = { amountAed: 500_000, requesterUserId: "owner", requireFinal: false, assigneeUserId: "lina" };
  it("the named delegate when they can take the amount", () => {
    expect(pickDelegate({ ...base, holders: [{ ...LINA, delegateUserId: "sara" }, SARA, MEDHAT] })).toEqual({ userId: "sara", via: "configured" });
  });
  it("the next tier when the named delegate raised the request, cannot cover it, or is no longer an approver", () => {
    expect(pickDelegate({ ...base, requesterUserId: "sara", holders: [{ ...LINA, delegateUserId: "sara" }, SARA, MEDHAT] })).toEqual({ userId: "medhat", via: "next-tier" });
    const small: ApproverHolder = { id: "rana", ceilingAed: 100_000, delegateUserId: null };
    expect(pickDelegate({ ...base, holders: [{ ...LINA, delegateUserId: "rana" }, small, MEDHAT] })).toEqual({ userId: "medhat", via: "next-tier" });
    expect(pickDelegate({ ...base, holders: [{ ...LINA, delegateUserId: "gone" }, MEDHAT] })).toEqual({ userId: "medhat", via: "next-tier" });
  });
  it("nobody when nobody could stand in", () => {
    expect(pickDelegate({ ...base, holders: [LINA] })).toBeNull();
  });
});

describe("hoursBetween", () => {
  it("never negative", () => {
    expect(hoursBetween(ago(5), NOW)).toBe(5);
    expect(hoursBetween(NOW, ago(5))).toBe(0);
  });
});
