/**
 * The spend-request approval chain (Sep 28, 2026): named levels in order,
 * whatever the amount; a stand-in for the final level who may hold the settle
 * grant; nobody approves the same request twice; a later chain edit never
 * reroutes a request in flight.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { judgeChainDecider, snapshotForRequester, validateChainConfig, type ChainPerson } from "@/lib/approvals/approval-chain";
import { createApprovalRequest, decideApprovalRequest, resolveApprover } from "@/lib/approvals/approvals-service";
import { planStepAction } from "@/lib/approvals/escalation-rules";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ORG = "org-1";
const CHAIN = { levels: ["vivek", "lina", "medhat"], standInUserId: "muthu" };

describe("snapshotForRequester", () => {
  it("keeps the whole chain for an outside requester, stand-in included", () => {
    expect(snapshotForRequester(CHAIN, "richard")).toEqual({ levels: ["vivek", "lina", "medhat"], standInUserId: "muthu" });
  });
  it("drops the requester's own level", () => {
    expect(snapshotForRequester(CHAIN, "vivek")).toEqual({ levels: ["lina", "medhat"], standInUserId: "muthu" });
  });
  it("hands the final level to the stand-in when the final approver raised it, and fails closed without one", () => {
    expect(snapshotForRequester(CHAIN, "medhat")).toEqual({ levels: ["vivek", "lina", "muthu"], standInUserId: "muthu" });
    expect(snapshotForRequester({ ...CHAIN, standInUserId: null }, "medhat")).toBeNull();
  });
  it("never lets the stand-in stand in on their own request", () => {
    expect(snapshotForRequester(CHAIN, "muthu")).toEqual({ levels: ["vivek", "lina", "medhat"], standInUserId: null });
  });
});

describe("judgeChainDecider", () => {
  const snapshot = { levels: ["vivek", "lina", "medhat"], standInUserId: "muthu" };
  const base = { snapshot, earlierApproverIds: [] as string[], deciderSettles: false };
  it("a level is decided by its person, with any approval access, whatever the amount", () => {
    expect(judgeChainDecider({ ...base, levelIndex: 0, step: { assigneeUserId: "vivek", delegateUserId: null }, deciderId: "vivek", deciderCeilingAed: 1 })).toEqual({ ok: true, asStandIn: false });
    expect(judgeChainDecider({ ...base, levelIndex: 0, step: { assigneeUserId: "vivek", delegateUserId: null }, deciderId: "lina", deciderCeilingAed: 1_000_000 })).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
    expect(judgeChainDecider({ ...base, levelIndex: 0, step: { assigneeUserId: "vivek", delegateUserId: null }, deciderId: "vivek", deciderCeilingAed: null })).toMatchObject({ ok: false, code: "INSUFFICIENT_AUTHORITY" });
  });
  it("the last level needs the unlimited approver, or the stand-in, who may hold the settle grant", () => {
    const step = { assigneeUserId: "medhat", delegateUserId: "muthu" };
    expect(judgeChainDecider({ ...base, levelIndex: 2, step, deciderId: "medhat", deciderCeilingAed: Number.POSITIVE_INFINITY })).toEqual({ ok: true, asStandIn: false });
    expect(judgeChainDecider({ ...base, levelIndex: 2, step, deciderId: "muthu", deciderCeilingAed: null, deciderSettles: true })).toEqual({ ok: true, asStandIn: true });
  });
  it("the stand-in only stands in at the last level, and the settle grant decides nothing else", () => {
    expect(judgeChainDecider({ ...base, levelIndex: 1, step: { assigneeUserId: "lina", delegateUserId: null }, deciderId: "muthu", deciderCeilingAed: null, deciderSettles: true })).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
    expect(judgeChainDecider({ ...base, levelIndex: 1, step: { assigneeUserId: "lina", delegateUserId: null }, deciderId: "lina", deciderCeilingAed: 5, deciderSettles: true })).toMatchObject({ ok: false, code: "SETTLE_CANNOT_DECIDE" });
  });
  it("a delegate at the last level still needs unlimited approval", () => {
    const snap = { levels: ["vivek", "medhat"], standInUserId: null };
    expect(judgeChainDecider({ snapshot: snap, earlierApproverIds: [], deciderSettles: false, levelIndex: 1, step: { assigneeUserId: "medhat", delegateUserId: "lina" }, deciderId: "lina", deciderCeilingAed: 1_000_000 })).toMatchObject({ ok: false, code: "INSUFFICIENT_AUTHORITY" });
  });
  it("a delegate who holds another level of the chain is refused in someone else's place (review H1)", () => {
    expect(judgeChainDecider({ ...base, levelIndex: 0, step: { assigneeUserId: "vivek", delegateUserId: "medhat" }, deciderId: "medhat", deciderCeilingAed: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
  });
  it("nobody approves the same request at two levels", () => {
    expect(judgeChainDecider({ ...base, earlierApproverIds: ["vivek"], levelIndex: 1, step: { assigneeUserId: "lina", delegateUserId: "vivek" }, deciderId: "vivek", deciderCeilingAed: 1_000_000 })).toMatchObject({ ok: false, code: "ALREADY_APPROVED_EARLIER" });
  });
});

describe("validateChainConfig", () => {
  const people: ChainPerson[] = [
    { id: "vivek", name: "Vivek", role: "ADMIN", active: true, ceilingAed: 20_000, settles: false },
    { id: "lina", name: "Lina", role: "ADMIN", active: true, ceilingAed: 1_000_000, settles: false },
    { id: "medhat", name: "Medhat", role: "ADMIN", active: true, ceilingAed: Number.POSITIVE_INFINITY, settles: false },
    { id: "muthu", name: "Muthu", role: "ADMIN", active: true, ceilingAed: null, settles: true },
    { id: "richard", name: "Richard", role: "ORGANIZER", active: true, ceilingAed: null, settles: false },
    { id: "krishna", name: "Krishna", role: "SUPER_ADMIN", active: true, ceilingAed: Number.POSITIVE_INFINITY, settles: false },
  ];
  const v = (levels: string[], standInUserId: string | null = null) => validateChainConfig({ levels, standInUserId }, people);
  it("accepts two to four approvers ending with the unlimited approver, with the settle holder as stand-in", () => {
    expect(v(["vivek", "medhat"], "muthu")).toEqual({ ok: true });
    expect(v(["vivek", "lina", "medhat"], "muthu")).toEqual({ ok: true });
  });
  it("refuses each broken shape with its own reason", () => {
    expect(v(["medhat"])).toMatchObject({ code: "TOO_FEW_LEVELS" });
    expect(v(["vivek", "lina", "vivek", "lina", "medhat"])).toMatchObject({ code: "TOO_MANY_LEVELS" });
    expect(v(["vivek", "vivek", "medhat"])).toMatchObject({ code: "DUPLICATE_PERSON" });
    expect(v(["ghost", "medhat"])).toMatchObject({ code: "UNKNOWN_PERSON" });
    expect(v(["vivek", "krishna"])).toMatchObject({ code: "SUPER_ADMIN_IN_CHAIN" });
    expect(v(["richard", "medhat"])).toMatchObject({ code: "LEVEL_NOT_APPROVER" });
    expect(v(["muthu", "medhat"])).toMatchObject({ code: "LEVEL_HOLDS_SETTLE" });
    expect(v(["vivek", "lina"])).toMatchObject({ code: "FINAL_NOT_UNLIMITED" });
    expect(v(["vivek", "medhat"], "vivek")).toMatchObject({ code: "STAND_IN_IS_LEVEL" });
  });
});

// ── the engine, walking a chain ─────────────────────────────────────────────

const ROWS: Record<string, Record<string, unknown>> = {
  vivek: { role: "ADMIN", procurementApproveCeilingAed: "20000", procurementApproveUnlimited: false, procurementSettle: false, procurementRequest: true },
  lina: { role: "ADMIN", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false, procurementSettle: false, procurementRequest: false },
  medhat: { role: "ADMIN", procurementApproveCeilingAed: null, procurementApproveUnlimited: true, procurementSettle: false, procurementRequest: false },
  muthu: { role: "ADMIN", procurementApproveCeilingAed: null, procurementApproveUnlimited: false, procurementSettle: true, procurementRequest: true },
};

type Step = { id: string; sequence: number; status: string; assigneeUserId: string; delegateUserId: string | null; decidedByUserId: string | null };

/** A tiny in-memory request so a chain can be walked from submit to the last level. */
function makeDb(chain: typeof CHAIN | null = CHAIN) {
  const state = { request: null as null | Record<string, unknown>, steps: [] as Step[] };
  const db = {
    user: {
      // The routing re-check reads the chain's people as they are now.
      findMany: vi.fn(async (args: { where: { id?: { in: string[] } } }) =>
        (args.where.id?.in ?? []).filter((id) => ROWS[id]).map((id) => ({ id, firstName: id, lastName: "", ...ROWS[id] })),
      ),
      findFirst: vi.fn(async (args: { where: { id: string } }) => (ROWS[args.where.id] ? { ...ROWS[args.where.id], permissionSets: [] } : null)),
    },
    approvalWorkflowDefinition: { findFirst: vi.fn().mockResolvedValue(chain ? { chain, bands: [] } : null) },
    approvalRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(async () => (state.request ? { ...state.request, steps: [...state.steps].sort((a, b) => a.sequence - b.sequence) } : null)),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const s = (args.data.steps as { create: Record<string, unknown> }).create;
        state.steps = [{ id: "step-1", sequence: 1, status: "PENDING", assigneeUserId: s.assigneeUserId as string, delegateUserId: (s.delegateUserId as string | null) ?? null, decidedByUserId: null }];
        state.request = { id: "req-1", organizationId: ORG, subjectType: "SPEND_REQUEST", subjectId: "sr-1", status: "PENDING", amountAed: "500", requesterUserId: args.data.requesterUserId, payload: args.data.payload };
        return { ...state.request, steps: state.steps };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (typeof args.data.status === "string") state.request!.status = args.data.status;
        return { ...state.request, steps: state.steps };
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approvalStep: {
      updateMany: vi.fn(async (args: { where: { id: string }; data: { status: string; decidedByUserId: string } }) => {
        const step = state.steps.find((s) => s.id === args.where.id && s.status === "PENDING");
        if (!step) return { count: 0 };
        step.status = args.data.status;
        step.decidedByUserId = args.data.decidedByUserId;
        return { count: 1 };
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const step: Step = { id: `step-${state.steps.length + 1}`, sequence: args.data.sequence as number, status: "PENDING", assigneeUserId: args.data.assigneeUserId as string, delegateUserId: (args.data.delegateUserId as string | null) ?? null, decidedByUserId: null };
        state.steps.push(step);
        return step;
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db: db as never, raw: db, state };
}

const submit = (db: never, over: Record<string, unknown> = {}) =>
  createApprovalRequest(db, { organizationId: ORG, subjectType: "SPEND_REQUEST", subjectId: "sr-1", amountAed: 500, requesterUserId: "richard", payload: { kind: "SUBMISSION" }, source: "ui", ...over });
const decide = (db: never, who: string, decision: "APPROVED" | "REJECTED" = "APPROVED") =>
  decideApprovalRequest(db, { organizationId: ORG, requestId: "req-1", decider: { id: who }, decision, note: decision === "REJECTED" ? "No." : null, source: "ui" });

beforeEach(() => vi.clearAllMocks());

describe("a chained spend request", () => {
  it("routes to level 1 whatever the amount, snapshotting the chain into the payload", async () => {
    const { db, raw } = makeDb();
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "SPEND_REQUEST", amountAed: 5_000_000, requesterUserId: "richard", requireFinalApprover: true })).toMatchObject({ ok: true, approverUserId: "vivek" });
    const r = await submit(db, { requireFinalApprover: true });
    expect(r.ok).toBe(true);
    const created = raw.approvalRequest.create.mock.calls[0][0].data as { payload: unknown; steps: { create: unknown } };
    expect(created.payload).toEqual({ kind: "SUBMISSION", requireFinalApprover: true, approvalChain: { levels: ["vivek", "lina", "medhat"], standInUserId: "muthu" } });
    expect(created.steps.create).toMatchObject({ assigneeUserId: "vivek", delegateUserId: null });
  });

  it("walks every level in order; only the last approval closes the request", async () => {
    const { db, state, raw } = makeDb();
    await submit(db);
    const one = await decide(db, "vivek");
    expect(one.ok && one.request.status).toBe("PENDING");
    expect(state.steps.map((s) => [s.assigneeUserId, s.status])).toEqual([["vivek", "APPROVED"], ["lina", "PENDING"]]);
    const two = await decide(db, "lina");
    expect(two.ok && two.request.status).toBe("PENDING");
    // The last level opens with the stand-in beside the final approver.
    expect(state.steps[2]).toMatchObject({ assigneeUserId: "medhat", delegateUserId: "muthu", status: "PENDING" });
    const three = await decide(db, "medhat");
    expect(three.ok && three.request.status).toBe("APPROVED");
    const actions = raw.auditLog.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);
    expect(actions).toEqual(["APPROVAL_REQUESTED", "APPROVAL_LEVEL_APPROVED", "APPROVAL_LEVEL_APPROVED", "APPROVAL_GRANTED"]);
  });

  it("the stand-in decides the last level although they hold the settle grant, and the audit row says so", async () => {
    const { db, raw } = makeDb();
    await submit(db);
    await decide(db, "vivek");
    await decide(db, "lina");
    const r = await decide(db, "muthu");
    expect(r.ok && r.request.status).toBe("APPROVED");
    const last = (raw.auditLog.create.mock.calls.at(-1)?.[0] as { data: { changes: unknown } }).data;
    expect(last.changes).toMatchObject({ asStandIn: true, standingInFor: "medhat", level: 3, levels: 3 });
  });

  it("the stand-in cannot jump the queue at an earlier level, and nobody skips a level", async () => {
    const { db } = makeDb();
    await submit(db);
    expect(await decide(db, "muthu")).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
    expect(await decide(db, "medhat")).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
  });

  it("a rejection at any level ends it", async () => {
    const { db, state } = makeDb();
    await submit(db);
    await decide(db, "vivek");
    const r = await decide(db, "lina", "REJECTED");
    expect(r.ok && r.request.status).toBe("REJECTED");
    expect(state.steps).toHaveLength(2);
  });

  it("a request in flight keeps its chain after the chain is edited", async () => {
    const { db, raw, state } = makeDb();
    await submit(db);
    raw.approvalWorkflowDefinition.findFirst.mockResolvedValue({ chain: { levels: ["lina", "medhat"], standInUserId: null }, bands: [] });
    await decide(db, "vivek");
    expect(state.steps[1].assigneeUserId).toBe("lina");
    await decide(db, "lina");
    expect(state.steps[2]).toMatchObject({ assigneeUserId: "medhat", delegateUserId: "muthu" });
  });

  it("refuses to route into a level whose person left or lost the access, naming them, and drops a stand-in who left (review H2)", async () => {
    const { db, raw } = makeDb();
    const saved = ROWS.lina;
    delete ROWS.lina;
    try {
      const r = await resolveApprover(db, { organizationId: ORG, subjectType: "SPEND_REQUEST", amountAed: 500, requesterUserId: "richard" });
      expect(r).toMatchObject({ ok: false, code: "NO_APPROVER" });
      if (!r.ok) expect(r.message).toContain("level 2");
    } finally {
      ROWS.lina = saved;
    }
    raw.approvalWorkflowDefinition.findFirst.mockResolvedValue({ chain: { levels: ["vivek", "lina", "medhat"], standInUserId: "gone" }, bands: [] });
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "SPEND_REQUEST", amountAed: 500, requesterUserId: "richard" })).toMatchObject({ ok: true, chain: { standInUserId: null } });
  });

  it("without a saved chain, spend requests keep the ceiling routing", async () => {
    const { db, raw } = makeDb(null);
    raw.user.findMany.mockResolvedValue([{ id: "lina", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false }] as never);
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "SPEND_REQUEST", amountAed: 500, requesterUserId: "richard" })).toEqual({ ok: true, approverUserId: "lina" });
  });
});

describe("the reminder timeline for a chain level", () => {
  const HOUR = 3_600_000;
  const created = new Date("2026-10-01T08:00:00Z");
  const step = (remindedAt: Date | null = null, delegateUserId: string | null = null) => ({ createdAt: created, dueAt: new Date(created.getTime() + 24 * HOUR), remindedAt, delegateUserId });
  const at = (h: number) => new Date(created.getTime() + h * HOUR);
  const ctx = (h: number, over: Record<string, unknown> = {}) => ({ now: at(h), assigneeCanDecide: true, delegateCanDecide: false, assigneeIsFinal: false, nextTierUserId: null, delegate: null, chain: true, ...over });
  it("reminds at 24 hours and daily after, never escalates, and stalls to the admins from 96 hours", () => {
    expect(planStepAction(step(), ctx(10))).toEqual({ kind: "none" });
    expect(planStepAction(step(), ctx(25))).toEqual({ kind: "remind", repeat: false });
    expect(planStepAction(step(at(25)), ctx(40))).toEqual({ kind: "none" });
    expect(planStepAction(step(at(25)), ctx(50))).toEqual({ kind: "remind", repeat: true });
    // Even with someone above who could take it, a level is never skipped.
    expect(planStepAction(step(at(73)), ctx(97, { nextTierUserId: "medhat" }))).toEqual({ kind: "stalled" });
    expect(planStepAction(step(at(97)), ctx(110))).toEqual({ kind: "none" });
    expect(planStepAction(step(at(97)), ctx(121))).toEqual({ kind: "stalled" });
  });
  it("adds the named delegate at 48 hours, once", () => {
    const delegate = { userId: "lina", via: "configured" as const };
    expect(planStepAction(step(at(25)), ctx(49, { delegate }))).toEqual({ kind: "delegate", toUserId: "lina", via: "configured" });
    expect(planStepAction(step(at(25), "lina"), ctx(50, { delegate }))).toEqual({ kind: "remind", repeat: true });
  });
  it("a level whose holder lost the access takes the named delegate at once, not at 48 hours (review H2)", () => {
    expect(planStepAction(step(), ctx(1, { assigneeCanDecide: false, delegate: { userId: "lina", via: "configured" } }))).toEqual({ kind: "delegate", toUserId: "lina", via: "configured" });
  });
  it("tells the admins at once when nobody holding the level can decide it", () => {
    expect(planStepAction(step(), ctx(1, { assigneeCanDecide: false }))).toEqual({ kind: "stuck" });
  });
});
