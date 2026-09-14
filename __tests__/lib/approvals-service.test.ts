/**
 * The approvals primitive's rules (spec §4, §8): requester never decides, the
 * tier above decides an approver's own request, the settle grant never
 * decides, the ceiling is checked in AED at decision time, and a decision is
 * a conditional claim so the second tab loses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cancelPendingApprovals,
  createApprovalRequest,
  decideApprovalRequest,
  resolveApprover,
} from "@/lib/approvals/approvals-service";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const ORG = "org-1";
const LINA = { id: "lina", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false };
const MEDHAT = { id: "medhat", procurementApproveCeilingAed: null, procurementApproveUnlimited: true };

function makeDb(over: Record<string, unknown> = {}) {
  return {
    user: { findMany: vi.fn().mockResolvedValue([LINA, MEDHAT]) },
    approvalWorkflowDefinition: { findFirst: vi.fn().mockResolvedValue(null) },
    approvalRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "req-1", ...args.data, steps: [{ id: "step-1", status: "PENDING", assigneeUserId: (args.data.steps as { create: { assigneeUserId: string } }).create.assigneeUserId }] })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "req-1", ...args.data, steps: [] })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    approvalStep: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    ...over,
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("resolveApprover", () => {
  it("routes on the lowest ceiling that covers the amount, skipping the requester", async () => {
    const db = makeDb();
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "BUDGET", amountAed: 500_000, requesterUserId: "owner" })).toEqual({ ok: true, approverUserId: "lina" });
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "BUDGET", amountAed: 1_000_000.01, requesterUserId: "owner" })).toEqual({ ok: true, approverUserId: "medhat" });
    // Lina's own request goes to the tier above her (spec §8.2).
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "BUDGET", amountAed: 100, requesterUserId: "lina" })).toEqual({ ok: true, approverUserId: "medhat" });
  });
  it("honours a definition's band order but never a band approver who lost the grant", async () => {
    const db = makeDb({
      approvalWorkflowDefinition: { findFirst: vi.fn().mockResolvedValue({ bands: [{ upToAed: "1000000", approverUserId: "ghost" }, { upToAed: null, approverUserId: "medhat" }] }) },
    });
    expect(await resolveApprover(db, { organizationId: ORG, subjectType: "BUDGET", amountAed: 10, requesterUserId: "owner" })).toEqual({ ok: true, approverUserId: "medhat" });
  });
  it("fails closed when nobody but the requester could decide", async () => {
    const db = makeDb({ user: { findMany: vi.fn().mockResolvedValue([MEDHAT]) } });
    const r = await resolveApprover(db, { organizationId: ORG, subjectType: "BUDGET", amountAed: 10, requesterUserId: "medhat" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NO_APPROVER");
  });
});

describe("createApprovalRequest", () => {
  it("creates one step for the resolved approver and supersedes a pending request on the same subject", async () => {
    const db = makeDb({
      approvalRequest: {
        findMany: vi.fn().mockResolvedValue([{ id: "old-req" }]),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "req-2", ...args.data, steps: [] })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const r = await createApprovalRequest(db, { organizationId: ORG, subjectType: "BUDGET", subjectId: "bud-1", amountAed: 5000, requesterUserId: "owner", source: "ui" });
    expect(r.ok).toBe(true);
    const created = (db as unknown as { approvalRequest: { create: ReturnType<typeof vi.fn> } }).approvalRequest.create.mock.calls[0][0].data;
    expect(created.steps.create.assigneeUserId).toBe("lina");
    expect(created.steps.create.sequence).toBe(1);
    const um = (db as unknown as { approvalRequest: { updateMany: ReturnType<typeof vi.fn> } }).approvalRequest.updateMany.mock.calls[0][0];
    expect(um.where.id.in).toEqual(["old-req"]);
    expect(um.data.status).toBe("SUPERSEDED");
    expect(um.data.supersededById).toBe("req-2");
  });
});

describe("decideApprovalRequest", () => {
  const pending = () => ({
    id: "req-1", organizationId: ORG, status: "PENDING", subjectType: "BUDGET", subjectId: "bud-1", amountAed: "500000", requesterUserId: "owner",
    steps: [{ id: "step-1", status: "PENDING", assigneeUserId: "lina", delegateUserId: null }],
  });
  it("lets the assignee with authority decide, once", async () => {
    const db = makeDb({ approvalRequest: { findFirst: vi.fn().mockResolvedValue(pending()), update: vi.fn(async (a: { data: Record<string, unknown> }) => ({ id: "req-1", ...a.data, steps: [] })), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() } });
    const r = await decideApprovalRequest(db, { organizationId: ORG, requestId: "req-1", decider: { id: "lina", role: "ADMIN", procurementApproveCeilingAed: 1_000_000 }, decision: "APPROVED", source: "ui" });
    expect(r.ok).toBe(true);
    const claim = (db as unknown as { approvalStep: { updateMany: ReturnType<typeof vi.fn> } }).approvalStep.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: "step-1", status: "PENDING" });
  });
  it("the second tab loses the claim", async () => {
    const db = makeDb({
      approvalRequest: { findFirst: vi.fn().mockResolvedValue(pending()), update: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
      approvalStep: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    });
    const r = await decideApprovalRequest(db, { organizationId: ORG, requestId: "req-1", decider: { id: "lina", role: "ADMIN", procurementApproveCeilingAed: 1_000_000 }, decision: "APPROVED", source: "ui" });
    expect(r).toMatchObject({ ok: false, code: "ALREADY_DECIDED" });
  });
  it("refuses the requester, a non-assignee, the settle grant, and a ceiling that does not cover", async () => {
    const db = () => makeDb({ approvalRequest: { findFirst: vi.fn().mockResolvedValue(pending()), update: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() } });
    expect(await decideApprovalRequest(db(), { organizationId: ORG, requestId: "req-1", decider: { id: "owner", role: "ORGANIZER", procurementApproveUnlimited: true }, decision: "APPROVED", source: "ui" })).toMatchObject({ ok: false, code: "REQUESTER_CANNOT_DECIDE" });
    expect(await decideApprovalRequest(db(), { organizationId: ORG, requestId: "req-1", decider: { id: "muthu", role: "MEMBER", procurementSettle: true }, decision: "APPROVED", source: "ui" })).toMatchObject({ ok: false, code: "SETTLE_CANNOT_DECIDE" });
    expect(await decideApprovalRequest(db(), { organizationId: ORG, requestId: "req-1", decider: { id: "medhat", role: "SUPER_ADMIN", procurementApproveUnlimited: true }, decision: "APPROVED", source: "ui" })).toMatchObject({ ok: false, code: "NOT_ASSIGNEE" });
    expect(await decideApprovalRequest(db(), { organizationId: ORG, requestId: "req-1", decider: { id: "lina", role: "ADMIN", procurementApproveCeilingAed: 1000 }, decision: "APPROVED", source: "ui" })).toMatchObject({ ok: false, code: "INSUFFICIENT_AUTHORITY" });
  });
  it("cancelPendingApprovals skips the steps and cancels the requests on a subject", async () => {
    const db = makeDb({ approvalRequest: { findMany: vi.fn().mockResolvedValue([{ id: "req-1" }, { id: "req-2" }]), updateMany: vi.fn().mockResolvedValue({ count: 2 }), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() } });
    expect(await cancelPendingApprovals(db, { organizationId: ORG, subjectType: "BUDGET", subjectId: "bud-1", actorUserId: "owner", source: "ui" })).toBe(2);
  });
});
