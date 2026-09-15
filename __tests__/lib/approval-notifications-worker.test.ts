/**
 * The approval-escalation tick against a mocked database: every action is a
 * conditional claim BEFORE its email, a lost claim sends nothing, the right
 * person gets the right email, the audit rows carry who moved it and why, and
 * a failed send is logged and never retried.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSend, mockEnabled, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    approvalStep: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    approvalRequest: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    user: { findMany: vi.fn() },
    eventBudget: { findMany: vi.fn() },
    spendRequest: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockSend: vi.fn(),
  mockEnabled: vi.fn(() => true),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => mockSend(...a) }));
vi.mock("@/lib/module-flags", () => ({ isProcurementModuleEnabled: () => mockEnabled() }));

import { runApprovalNotificationsTick } from "@/lib/approvals/approval-notifications-worker";

const H = 3_600_000;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * H);
const ORG = "org-1";

const PEOPLE = [
  { id: "owner", firstName: "Dev", lastName: "Admin", email: "dev@x.test", deactivatedAt: null },
  { id: "lina", firstName: "Lina", lastName: "H", email: "lina@x.test", deactivatedAt: null },
  { id: "sara", firstName: "Sara", lastName: "K", email: "sara@x.test", deactivatedAt: null },
  { id: "medhat", firstName: "Medhat", lastName: "F", email: "medhat@x.test", deactivatedAt: null },
];
const HOLDER = {
  lina: { id: "lina", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false, procurementDelegateUserId: null as string | null },
  sara: { id: "sara", procurementApproveCeilingAed: "2000000", procurementApproveUnlimited: false, procurementDelegateUserId: null },
  medhat: { id: "medhat", procurementApproveCeilingAed: null, procurementApproveUnlimited: true, procurementDelegateUserId: null },
};

function stepRow(o: Partial<{ id: string; ageHours: number; notifiedAt: Date | null; remindedAt: Date | null; delegateUserId: string | null; sequence: number; assignee: string; amountAed: string; payload: unknown; subjectType: string; subjectId: string }> = {}) {
  const createdAt = ago(o.ageHours ?? 1);
  return {
    id: o.id ?? "step-1",
    organizationId: ORG,
    requestId: "req-1",
    sequence: o.sequence ?? 1,
    assigneeUserId: o.assignee ?? "lina",
    delegateUserId: o.delegateUserId ?? null,
    dueAt: new Date(createdAt.getTime() + 24 * H),
    remindedAt: o.remindedAt ?? null,
    notifiedAt: o.notifiedAt === undefined ? createdAt : o.notifiedAt,
    createdAt,
    request: { id: "req-1", subjectType: o.subjectType ?? "BUDGET", subjectId: o.subjectId ?? "bud-1", amountAed: o.amountAed ?? "500000", amount: null, currency: "AED", requesterUserId: "owner", payload: o.payload ?? null },
  };
}

function setup(o: { steps?: unknown[]; decided?: unknown[]; holders?: unknown[]; people?: unknown[] } = {}) {
  mockDb.approvalStep.findMany.mockResolvedValue(o.steps ?? []);
  mockDb.approvalRequest.findMany.mockResolvedValue(o.decided ?? []);
  mockDb.user.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    args.where.OR ? (o.holders ?? [HOLDER.lina, HOLDER.medhat]) : (o.people ?? PEOPLE),
  );
}

const sentTo = () => mockSend.mock.calls.map((c) => (c[0] as { to: { email: string }[] }).to[0].email);
const sent = (i = 0) => mockSend.mock.calls[i][0] as { subject: string; textContent: string; logContext: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://events.example.test/";
  mockEnabled.mockReturnValue(true);
  mockSend.mockResolvedValue({ success: true });
  mockDb.approvalStep.updateMany.mockResolvedValue({ count: 1 });
  mockDb.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
  mockDb.approvalRequest.findFirst.mockResolvedValue({ id: "req-1" });
  mockDb.approvalStep.create.mockResolvedValue({ id: "step-2" });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.eventBudget.findMany.mockResolvedValue([{ id: "bud-1", eventCode: "HM2026", versionNo: 2, event: { name: "Hematology Summit" } }]);
  mockDb.spendRequest.findMany.mockResolvedValue([{ id: "sr1", requestNo: "PR-2026-0004", title: "LED wall" }]);
  setup();
});

describe("the scans", () => {
  it("does nothing at all while the module is off", async () => {
    mockEnabled.mockReturnValue(false);
    const r = await runApprovalNotificationsTick(NOW);
    expect(r).toMatchObject({ assigned: 0, reminded: 0, delegated: 0, escalated: 0, decided: 0 });
    expect(mockDb.approvalStep.findMany).not.toHaveBeenCalled();
  });
  it("reads pending steps of pending requests, and decisions from the last seven days only", async () => {
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.findMany.mock.calls[0][0].where).toEqual({ status: "PENDING", request: { status: "PENDING" } });
    const decided = mockDb.approvalRequest.findMany.mock.calls[0][0].where;
    expect(decided).toMatchObject({ status: { in: ["APPROVED", "REJECTED"] }, decisionNotifiedAt: null });
    expect(decided.decidedAt.gte.toISOString()).toBe("2026-09-08T12:00:00.000Z");
  });
  it("never counts a settle holder among those who can decide", async () => {
    setup({ steps: [stepRow({ notifiedAt: null })] });
    await runApprovalNotificationsTick(NOW);
    const holders = mockDb.user.findMany.mock.calls.find((c) => (c[0] as { where: Record<string, unknown> }).where.OR)![0];
    expect(holders.where).toMatchObject({ organizationId: ORG, deactivatedAt: null, procurementSettle: false });
  });
});

describe("the assignment email", () => {
  it("claims notifiedAt first, then emails the assignee a link to the Approvals page", async () => {
    setup({ steps: [stepRow({ notifiedAt: null })] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0]).toEqual({ where: { id: "step-1", organizationId: ORG, status: "PENDING", notifiedAt: null }, data: { notifiedAt: NOW } });
    expect(sentTo()).toEqual(["lina@x.test"]);
    expect(sent().subject).toBe("Approval needed: HM2026 v2 · Hematology Summit");
    expect(sent().textContent).toContain("https://events.example.test/procurement/approvals");
    expect(sent().logContext).toMatchObject({ organizationId: ORG, entityType: "USER", entityId: "lina", templateSlug: "procurement-approval-assigned" });
    expect(r.assigned).toBe(1);
  });
  it("sends nothing when another tick claimed it first", async () => {
    setup({ steps: [stepRow({ notifiedAt: null })] });
    mockDb.approvalStep.updateMany.mockResolvedValue({ count: 0 });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toMatchObject({ assigned: 0, skipped: 1 });
  });
  it("a step first seen past its due time gets one email that counts as its reminder", async () => {
    setup({ steps: [stepRow({ notifiedAt: null, ageHours: 30 })] });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0].data).toEqual({ notifiedAt: NOW, remindedAt: NOW });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it("mails nothing about a step older than seven days", async () => {
    setup({ steps: [stepRow({ notifiedAt: null, ageHours: 200, assignee: "medhat", remindedAt: ago(1) })] });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("reminders", () => {
  it("reminds a banded approver once at 24 hours, claiming on the observed remindedAt", async () => {
    setup({ steps: [stepRow({ ageHours: 25 })] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0]).toEqual({ where: { id: "step-1", organizationId: ORG, status: "PENDING", remindedAt: null }, data: { remindedAt: NOW } });
    expect(sent().subject).toBe("Reminder, waiting on your approval: HM2026 v2 · Hematology Summit");
    expect(sent().textContent).toContain("waiting 25 hours");
    expect(r.reminded).toBe(1);
    vi.clearAllMocks();
    mockDb.approvalStep.updateMany.mockResolvedValue({ count: 1 });
    setup({ steps: [stepRow({ ageHours: 30, remindedAt: ago(5) })] });
    await runApprovalNotificationsTick(NOW);
    expect(mockSend).not.toHaveBeenCalled();
  });
  it("the final approver is reminded daily and never delegated or escalated", async () => {
    const remindedAt = ago(25);
    setup({ steps: [stepRow({ ageHours: 120, assignee: "medhat", remindedAt })], holders: [HOLDER.lina, HOLDER.sara, HOLDER.medhat] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0].where).toMatchObject({ remindedAt });
    expect(sentTo()).toEqual(["medhat@x.test"]);
    expect(mockDb.approvalStep.create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ reminded: 1, delegated: 0, escalated: 0 });
  });
  it("an over-budget exception on the final approver stays with them however long it waits", async () => {
    setup({ steps: [stepRow({ ageHours: 200, assignee: "medhat", remindedAt: ago(30), payload: { kind: "SUBMISSION", requireFinalApprover: true } })], holders: [HOLDER.lina, HOLDER.sara, HOLDER.medhat] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(r).toMatchObject({ reminded: 1, delegated: 0, escalated: 0 });
    expect(sent().textContent).toContain("Over-budget exception");
  });
});

describe("delegation at 48 hours", () => {
  it("names the configured delegate, writes the audit row, and emails them", async () => {
    setup({ steps: [stepRow({ ageHours: 49, remindedAt: ago(25) })], holders: [{ ...HOLDER.lina, procurementDelegateUserId: "sara" }, HOLDER.sara, HOLDER.medhat] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0]).toEqual({ where: { id: "step-1", organizationId: ORG, status: "PENDING", delegateUserId: null }, data: { delegateUserId: "sara" } });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ userId: null, organizationId: ORG, action: "APPROVAL_DELEGATED", entityType: "ApprovalRequest", entityId: "req-1" });
    expect(audit.changes).toMatchObject({ source: "worker", fromUserId: "lina", toUserId: "sara", via: "configured", afterHours: 49 });
    expect(sentTo()).toEqual(["sara@x.test"]);
    expect(sent().subject).toBe("You can now approve: HM2026 v2 · Hematology Summit");
    expect(sent().textContent).toContain("has waited 2 days for Lina H");
    expect(r.delegated).toBe(1);
  });
  it("falls to the next tier when the configured delegate raised the request", async () => {
    setup({ steps: [stepRow({ ageHours: 49, remindedAt: ago(25) })], holders: [{ ...HOLDER.lina, procurementDelegateUserId: "owner" }, HOLDER.medhat] });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0].data).toEqual({ delegateUserId: "medhat" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ via: "next-tier" });
  });
  it("a step never reminded is stamped reminded by the delegation, so no reminder follows", async () => {
    setup({ steps: [stepRow({ ageHours: 50 })] });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0].data).toEqual({ delegateUserId: "medhat", remindedAt: NOW });
  });
  it("the delegate is reminded beside the assignee afterwards only where the step cannot move", async () => {
    // A delegated banded step between 48 and 96 hours gets no reminders at all.
    setup({ steps: [stepRow({ ageHours: 70, remindedAt: ago(22), delegateUserId: "medhat" })] });
    await runApprovalNotificationsTick(NOW);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("escalation", () => {
  it("at 96 hours closes the step, opens the next tier's, audits, and emails the new approver", async () => {
    setup({ steps: [stepRow({ ageHours: 97, remindedAt: ago(73), delegateUserId: "medhat" })] });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.updateMany.mock.calls[0][0]).toEqual({ where: { id: "step-1", organizationId: ORG, status: "PENDING", escalatedAt: null }, data: { status: "SKIPPED", escalatedAt: NOW } });
    expect(mockDb.approvalStep.create.mock.calls[0][0].data).toEqual({ organizationId: ORG, requestId: "req-1", sequence: 2, assigneeUserId: "medhat", dueAt: new Date(NOW.getTime() + 24 * H), notifiedAt: NOW });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ source: "worker", fromUserId: "lina", toUserId: "medhat", reason: "no-decision", afterHours: 97, toStepId: "step-2" });
    expect(sentTo()).toEqual(["medhat@x.test"]);
    expect(sent().subject).toBe("Approval passed to you: HM2026 v2 · Hematology Summit");
    expect(r.escalated).toBe(1);
  });
  it("opens nothing when the request was decided or cancelled a moment earlier", async () => {
    setup({ steps: [stepRow({ ageHours: 97, remindedAt: ago(73) })] });
    mockDb.approvalRequest.findFirst.mockResolvedValue(null);
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r).toMatchObject({ escalated: 0, skipped: 1 });
  });
  it("sends nothing when the claim is lost to a second tick", async () => {
    setup({ steps: [stepRow({ ageHours: 97, remindedAt: ago(73) })] });
    mockDb.approvalStep.updateMany.mockResolvedValue({ count: 0 });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalStep.create).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
  it("an assignee who lost their authority passes it on at once, as a plain assignment", async () => {
    setup({ steps: [stepRow({ ageHours: 2 })], holders: [HOLDER.medhat] });
    await runApprovalNotificationsTick(NOW);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ reason: "assignee-lost-authority", toUserId: "medhat" });
    expect(sent().subject).toBe("Approval needed: HM2026 v2 · Hematology Summit");
  });
});

describe("the decision email", () => {
  it("claims decisionNotifiedAt, then tells the requester who decided and links to the request", async () => {
    setup({
      decided: [{ id: "req-9", organizationId: ORG, status: "REJECTED", subjectType: "SPEND_REQUEST", subjectId: "sr1", amountAed: "5000", amount: "5000", currency: "AED", requesterUserId: "owner", payload: { kind: "SUBMISSION" }, steps: [{ decidedByUserId: "lina", note: "Get a second quote" }] }],
    });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockDb.approvalRequest.updateMany.mock.calls[0][0]).toEqual({ where: { id: "req-9", organizationId: ORG, status: "REJECTED", decisionNotifiedAt: null }, data: { decisionNotifiedAt: NOW } });
    expect(sentTo()).toEqual(["dev@x.test"]);
    expect(sent().subject).toBe("Rejected: PR-2026-0004 · LED wall");
    expect(sent().textContent).toContain("Lina H rejected your spend request.");
    expect(sent().textContent).toContain("Note: Get a second quote");
    expect(sent().textContent).toContain("https://events.example.test/procurement/requests/sr1");
    expect(r.decided).toBe(1);
  });
});

describe("failures", () => {
  it("a failed send is logged at error and the claim is kept, never retried", async () => {
    setup({ steps: [stepRow({ notifiedAt: null })] });
    mockSend.mockResolvedValue({ success: false, error: "boom" });
    const r = await runApprovalNotificationsTick(NOW);
    expect(r).toMatchObject({ assigned: 1, failed: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "approvals-notify:send-failed", kind: "assigned", recipientUserId: "lina" }));
    expect(mockDb.approvalStep.updateMany).toHaveBeenCalledTimes(1);
  });
  it("a deactivated recipient is skipped with a warning, not mailed", async () => {
    setup({ steps: [stepRow({ notifiedAt: null })], people: PEOPLE.map((p) => (p.id === "lina" ? { ...p, deactivatedAt: ago(1) } : p)) });
    const r = await runApprovalNotificationsTick(NOW);
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "approvals-notify:recipient-unreachable", recipientUserId: "lina", deactivated: true }));
  });
  it("one organisation's failure does not stop the next", async () => {
    setup({ steps: [stepRow({ notifiedAt: null }), { ...stepRow({ id: "step-9", notifiedAt: null }), organizationId: "org-2" }] });
    mockDb.user.findMany.mockImplementationOnce(async () => {
      throw new Error("db blip");
    });
    const r = await runApprovalNotificationsTick(NOW);
    expect(r.failed).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "approvals-notify:org-failed", organizationId: ORG }));
    expect(mockDb.approvalStep.updateMany.mock.calls.some((c) => c[0].where.id === "step-9")).toBe(true);
  });
});
