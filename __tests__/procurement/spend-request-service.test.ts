/**
 * The spend-request service with the db mocked and the approvals primitive
 * REAL: a draft takes a PR number from the counter, the final approver is
 * refused as a requester, submit runs the budget check and routes within
 * budget to the lowest ceiling and over budget to the final approver only,
 * a frozen budget's exception demands a reason, the decision lands APPROVED
 * or AWAITING_SUPPLIER, a rise after approval is routed on the new total, a
 * fall applies at once, and withdraw and cancel keep their rules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const HOLDERS = [
  { id: "lina", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false },
  { id: "medhat", procurementApproveCeilingAed: null, procurementApproveUnlimited: true },
];
const ROWS: Record<string, Record<string, unknown>> = {
  lina: { role: "ADMIN", procurementApproveCeilingAed: "1000000", procurementApproveUnlimited: false, procurementSettle: false, procurementRequest: false },
  medhat: { role: "SUPER_ADMIN", procurementApproveCeilingAed: null, procurementApproveUnlimited: true, procurementSettle: false, procurementRequest: false },
  req: { role: "MEMBER", procurementApproveCeilingAed: null, procurementApproveUnlimited: false, procurementSettle: false, procurementRequest: true },
};

const mockDb = vi.hoisted(() => ({
  spendRequest: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  commitment: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  spendRequestQuote: { create: vi.fn().mockResolvedValue({ id: "q1" }), updateMany: vi.fn().mockResolvedValue({ count: 0 }), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  spendRequestCounter: { upsert: vi.fn().mockResolvedValue({ lastSerial: 7 }) },
  eventBudget: { findFirst: vi.fn() },
  budgetLine: { findFirst: vi.fn() },
  budgetCategory: { findFirst: vi.fn().mockResolvedValue({ id: "c-av" }) },
  supplier: { findFirst: vi.fn() },
  user: { findMany: vi.fn(), findFirst: vi.fn() },
  approvalWorkflowDefinition: { findFirst: vi.fn().mockResolvedValue(null) },
  approvalRequest: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  approvalStep: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// The order is issued INSIDE the decision's transaction (slice 3); its own mechanics are pinned in commitment-service.test.ts.
const orderSvc = vi.hoisted(() => ({ issueOrderInTx: vi.fn(), afterOrderIssued: vi.fn() }));
vi.mock("@/procurement/services/commitment-service", () => ({ ...orderSvc, COMMITMENT_SELECT: {}, toCommitmentView: (x: unknown) => x }));

import { addQuote, amendSpendRequest, createSpendRequest, decideSpendRequest, submitSpendRequest, transitionSpendRequest } from "@/procurement/services/spend-request-service";

const ORG = "org-1";
const actor = { id: "req", isAdmin: false };
const base = { organizationId: ORG, actor, source: "ui" as const };
const budget = (status = "ACTIVE") => ({ id: "b1", eventCode: "HM2026", status, reportingCurrency: "AED", versionNo: 1 });
const line = (over: Partial<{ planned: string; committedOpen: string; actual: string }> = {}) => ({ id: "l1", lineKey: "k-av", description: "LED wall", planned: "10000", committedOpen: "2500", actual: "1000", categoryId: "c-av", isContingency: false, category: { id: "c-av", code: "AV", name: "AV" }, ...over });
const request = (over: Record<string, unknown> = {}) => ({
  id: "sr1", organizationId: ORG, requestNo: "PR-2026-0007", budgetId: "b1", lineKey: "k-av", eventCode: "HM2026", requesterUserId: "req", supplierId: "s1", proposedVendorName: null,
  title: "LED wall", justification: null, amount: "5000", taxAmount: "250", currency: "AED", fxRateToReporting: "1", amountAed: null, categoryId: "c-av", neededBy: null,
  sourcingMethod: null, budgetCheckStatus: "NOT_CHECKED", status: "DRAFT", priority: "NORMAL", linkedCommitmentId: null, approvalRequestId: null, submittedAt: null, decidedAt: null,
  decidedByUserId: null, decisionNote: null, cancelledAt: null, cancelReason: null, version: 1, createdAt: new Date("2026-09-14T00:00:00Z"), updatedAt: new Date("2026-09-14T00:00:00Z"),
  budget: { id: "b1", eventCode: "HM2026", versionNo: 1, status: "ACTIVE", reportingCurrency: "AED", event: { name: "HM" } },
  supplier: { id: "s1", code: "GULFAV", displayName: "Gulf AV", approvalStatus: "APPROVED", isActive: true },
  category: { id: "c-av", code: "AV", name: "AV" },
  quotes: [{ id: "q1", vendorName: "Gulf AV", supplierId: "s1", amount: "5000", taxAmount: "250", currency: "AED", quotedOn: null, validUntil: null, recommended: true, notes: null, mediaFileId: null, createdAt: new Date(), supplier: null }],
  ...over,
});
const created = () => mockDb.approvalRequest.create.mock.calls[0][0].data;
const updated = () => mockDb.spendRequest.updateMany.mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.spendRequest.findMany.mockResolvedValue([]);
  mockDb.spendRequest.updateMany.mockResolvedValue({ count: 1 });
  mockDb.spendRequestCounter.upsert.mockResolvedValue({ lastSerial: 7 });
  mockDb.eventBudget.findFirst.mockResolvedValue(budget());
  mockDb.budgetLine.findFirst.mockResolvedValue(line());
  mockDb.budgetCategory.findFirst.mockResolvedValue({ id: "c-av" });
  mockDb.supplier.findFirst.mockResolvedValue({ id: "s1", approvalStatus: "APPROVED", isActive: true });
  mockDb.user.findMany.mockResolvedValue(HOLDERS);
  mockDb.user.findFirst.mockImplementation(async (args: { where: { id: string } }) => ROWS[args.where.id] ?? null);
  mockDb.approvalWorkflowDefinition.findFirst.mockResolvedValue(null);
  mockDb.approvalRequest.findMany.mockResolvedValue([]);
  mockDb.approvalRequest.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "ar1", ...args.data, steps: [] }));
  mockDb.approvalRequest.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "ar1", ...args.data, steps: [] }));
  mockDb.approvalStep.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.spendRequest.findFirst.mockResolvedValue(request());
  mockDb.spendRequest.create.mockResolvedValue({ id: "sr1" });
  orderSvc.issueOrderInTx.mockResolvedValue({ ok: true, commitmentId: "c1", commitmentNo: "PO-2026-0001" });
  orderSvc.afterOrderIssued.mockResolvedValue(undefined);
});

describe("createSpendRequest", () => {
  it("takes the next PR number inside the transaction, stores the derived rate and the line's category, and audits", async () => {
    const r = await createSpendRequest({ ...base, budgetId: "b1", lineKey: "k-av", title: " LED wall ", amount: "5000", currency: "aed", supplierId: "s1" });
    expect(r.ok).toBe(true);
    expect(mockDb.spendRequestCounter.upsert).toHaveBeenCalledTimes(1);
    const data = mockDb.spendRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ requestNo: "PR-2026-0007", budgetId: "b1", lineKey: "k-av", eventCode: "HM2026", requesterUserId: "req", title: "LED wall", amount: "5000.0000", taxAmount: "0.0000", currency: "AED", fxRateToReporting: "1", categoryId: "c-av", priority: "NORMAL" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ entityType: "SpendRequest", action: "CREATE", changes: expect.objectContaining({ requestNo: "PR-2026-0007", budgetId: "b1" }) });
  });
  it("derives USD to AED from the pegs and demands a rate for a floating pair", async () => {
    await createSpendRequest({ ...base, budgetId: "b1", title: "x", amount: "100", currency: "USD" });
    expect(mockDb.spendRequest.create.mock.calls[0][0].data.fxRateToReporting).toBe("3.6725");
    expect(await createSpendRequest({ ...base, budgetId: "b1", title: "x", amount: "100", currency: "EUR" })).toMatchObject({ ok: false, code: "RATE_REQUIRED" });
    // Review H1: a typed rate cannot read two million euros as two thousand dirhams.
    const banded = await createSpendRequest({ ...base, budgetId: "b1", title: "x", amount: "2000000", currency: "EUR", fxRateToReporting: "0.001" });
    expect(banded).toMatchObject({ ok: false, code: "RATE_REQUIRED", meta: { reason: "out-of-band" } });
    expect(!banded.ok && banded.message).toContain("2.5 to 8");
    expect(mockDb.spendRequest.create).toHaveBeenCalledTimes(1);
    await createSpendRequest({ ...base, budgetId: "b1", title: "x", amount: "100", currency: "EUR", fxRateToReporting: "4.2" });
    expect(mockDb.spendRequest.create.mock.calls[1][0].data.fxRateToReporting).toBe("4.2");
  });
  it("refuses the final approver, a budget that is not active or frozen, and an unknown line", async () => {
    expect(await createSpendRequest({ ...base, actor: { id: "medhat", isAdmin: true }, budgetId: "b1", title: "x", amount: "1", currency: "AED" })).toMatchObject({ ok: false, code: "FINAL_APPROVER_CANNOT_REQUEST" });
    mockDb.eventBudget.findFirst.mockResolvedValue(budget("DRAFT"));
    expect(await createSpendRequest({ ...base, budgetId: "b1", title: "x", amount: "1", currency: "AED" })).toMatchObject({ ok: false, code: "BUDGET_NOT_ACTIVE" });
    mockDb.eventBudget.findFirst.mockResolvedValue(budget("FROZEN"));
    mockDb.budgetLine.findFirst.mockResolvedValue(null);
    expect(await createSpendRequest({ ...base, budgetId: "b1", lineKey: "nope", title: "x", amount: "1", currency: "AED" })).toMatchObject({ ok: false, code: "LINE_NOT_FOUND" });
    expect(mockDb.spendRequest.create).not.toHaveBeenCalled();
  });
});

describe("submitSpendRequest", () => {
  const submit = (over: Record<string, unknown> = {}) => submitSpendRequest({ ...base, requestId: "sr1", expectedVersion: 1, ...over });

  it("within budget: the check passes, the request is routed to the lowest ceiling and marked pending", async () => {
    const r = await submit();
    expect(r.ok).toBe(true);
    const ar = created();
    expect(ar).toMatchObject({ subjectType: "SPEND_REQUEST", subjectId: "sr1", amountAed: 5000, amount: "5000.0000", currency: "AED", requesterUserId: "req" });
    expect(ar.steps.create.assigneeUserId).toBe("lina");
    expect(ar.payload).toMatchObject({ kind: "SUBMISSION", budgetCheck: "WITHIN_BUDGET", amountReporting: "5000.0000", remainingBefore: "6500.0000", remainingAfter: "1500.0000", reportingToAedRate: "1", rateSource: "peg" });
    expect(ar.payload.requireFinalApprover).toBeUndefined();
    expect(updated().where).toMatchObject({ id: "sr1", status: "DRAFT", version: 1 });
    expect(updated().data).toMatchObject({ status: "PENDING_APPROVAL", budgetCheckStatus: "WITHIN_BUDGET", amountAed: "5000.0000", approvalRequestId: "ar1" });
    expect(mockDb.auditLog.create.mock.calls.map((c) => c[0].data.action)).toContain("SUBMIT");
  });
  it("over budget: never let through, marked OVER_BUDGET and routed to the final approver only", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ amount: "6500.01" }));
    const r = await submit();
    expect(r.ok).toBe(true);
    const ar = created();
    expect(ar.steps.create.assigneeUserId).toBe("medhat");
    expect(ar.payload).toMatchObject({ kind: "SUBMISSION", budgetCheck: "OVER_BUDGET", remainingAfter: "-0.0100", requireFinalApprover: true });
    expect(updated().data.budgetCheckStatus).toBe("OVER_BUDGET");
  });
  it("over budget on a frozen budget needs the requester's reason, then routes as the FROZEN exception", async () => {
    mockDb.eventBudget.findFirst.mockResolvedValue(budget("FROZEN"));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ amount: "9000" }));
    expect(await submit()).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(mockDb.approvalRequest.create).not.toHaveBeenCalled();
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ amount: "9000", justification: "The venue changed the stage size." }));
    const r = await submit();
    expect(r.ok).toBe(true);
    expect(created().payload).toMatchObject({ budgetCheck: "FROZEN", requireFinalApprover: true });
    expect(created().reason).toBe("The venue changed the stage size.");
  });
  it("a USD request on an AED budget is checked in AED at the peg", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ currency: "USD", fxRateToReporting: "3.6725", amount: "1000" }));
    await submit();
    expect(created().payload).toMatchObject({ amountReporting: "3672.5000", requestToReportingRate: "3.6725" });
    expect(created().amountAed).toBe(3672.5);
  });
  it("refuses an incomplete draft with the list, a non-requester, the final approver, and a closed budget", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ quotes: [], supplierId: null, supplier: null }));
    expect(await submit()).toMatchObject({ ok: false, code: "INCOMPLETE", meta: { missing: ["a supplier, or the name of the vendor you propose", "at least one quote"] } });
    mockDb.spendRequest.findFirst.mockResolvedValue(request());
    expect(await submit({ actor: { id: "someone", isAdmin: true } })).toMatchObject({ ok: false, code: "NOT_REQUESTER" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ requesterUserId: "medhat" }));
    expect(await submit({ actor: { id: "medhat", isAdmin: true } })).toMatchObject({ ok: false, code: "FINAL_APPROVER_CANNOT_REQUEST" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request());
    mockDb.eventBudget.findFirst.mockResolvedValue(budget("CLOSED"));
    expect(await submit()).toMatchObject({ ok: false, code: "BUDGET_NOT_ACTIVE" });
    expect(mockDb.approvalRequest.create).not.toHaveBeenCalled();
  });
  it("a lost version claim is STALE_WRITE and nothing else is written", async () => {
    mockDb.spendRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await submit()).toMatchObject({ ok: false, code: "STALE_WRITE" });
  });
});

describe("decideSpendRequest", () => {
  const pendingApproval = (payload: Record<string, unknown>, assignee = "lina") => ({
    id: "ar1", organizationId: ORG, subjectType: "SPEND_REQUEST", subjectId: "sr1", status: "PENDING", amountAed: "5000", requesterUserId: "req", payload,
    steps: [{ id: "st1", status: "PENDING", assigneeUserId: assignee, delegateUserId: null }],
  });
  const lina = { id: "lina", role: "ADMIN", procurementApproveCeilingAed: 1_000_000 };
  const submission = { kind: "SUBMISSION", budgetCheck: "WITHIN_BUDGET" };

  it("approves to APPROVED when the supplier is approved and to AWAITING_SUPPLIER when it is not", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval(submission));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    expect((await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED", note: "Fine" })).ok).toBe(true);
    expect(updated().where).toMatchObject({ id: "sr1", status: "PENDING_APPROVAL" });
    expect(updated().data).toMatchObject({ status: "APPROVED", decidedByUserId: "lina", decisionNote: "Fine" });
    mockDb.supplier.findFirst.mockResolvedValue({ approvalStatus: "PROPOSED", isActive: true });
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" });
    expect(updated().data.status).toBe("AWAITING_SUPPLIER");
  });
  it("an approval whose supplier is approved issues the order in the same transaction; awaiting supplier does not; an order that cannot be issued fails the decision", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval(submission));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    expect((await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" })).ok).toBe(true);
    expect(orderSvc.issueOrderInTx).toHaveBeenCalledTimes(1);
    expect(orderSvc.issueOrderInTx.mock.calls[0][0]).toBe(mockDb);
    expect(orderSvc.issueOrderInTx.mock.calls[0][1]).toMatchObject({ organizationId: ORG, actorUserId: "lina", source: "ui", requestId: "sr1" });
    expect(orderSvc.afterOrderIssued).toHaveBeenCalledWith({ organizationId: ORG, actorUserId: "lina", source: "ui", commitmentId: "c1" });
    mockDb.supplier.findFirst.mockResolvedValue({ approvalStatus: "PROPOSED", isActive: true });
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" });
    expect(orderSvc.issueOrderInTx).toHaveBeenCalledTimes(1);
    mockDb.supplier.findFirst.mockResolvedValue({ approvalStatus: "APPROVED", isActive: true });
    orderSvc.issueOrderInTx.mockResolvedValueOnce({ ok: false, code: "LINE_NOT_FOUND", message: "gone" });
    expect(await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" })).toMatchObject({ ok: false, code: "LINE_NOT_FOUND" });
    expect(orderSvc.afterOrderIssued).toHaveBeenCalledTimes(1);
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "REJECTED" });
    expect(orderSvc.issueOrderInTx).toHaveBeenCalledTimes(2);
  });
  it("rejects to REJECTED and refuses the requester through the primitive", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval(submission));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "REJECTED", note: "No" });
    expect(updated().data).toMatchObject({ status: "REJECTED", decisionNote: "No" });
    const own = await decideSpendRequest({ organizationId: ORG, decider: { id: "req", role: "MEMBER", procurementApproveUnlimited: true }, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" });
    expect(own).toMatchObject({ ok: false, code: "APPROVAL_FAILED", meta: { code: "REQUESTER_CANNOT_DECIDE" } });
  });
  it("an exception assigned to the final approver is refused to a ceiling holder, and taken by the final approver", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval({ ...submission, budgetCheck: "OVER_BUDGET", requireFinalApprover: true }, "medhat"));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL", budgetCheckStatus: "OVER_BUDGET" }));
    expect(await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" })).toMatchObject({ ok: false, code: "APPROVAL_FAILED" });
    expect(mockDb.spendRequest.updateMany).not.toHaveBeenCalled();
    const r = await decideSpendRequest({ organizationId: ORG, decider: { id: "medhat", role: "SUPER_ADMIN", procurementApproveUnlimited: true }, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" });
    expect(r.ok).toBe(true);
    expect(updated().data.status).toBe("APPROVED");
  });
  it("an approval is refused once the budget version no longer takes requests; a rejection still lands", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval(submission));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    mockDb.eventBudget.findFirst.mockResolvedValue(budget("ARCHIVED"));
    expect(await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" })).toMatchObject({ ok: false, code: "BUDGET_NOT_ACTIVE" });
    expect(mockDb.spendRequest.updateMany).not.toHaveBeenCalled();
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "REJECTED", note: "Late" });
    expect(updated().data).toMatchObject({ status: "REJECTED", decisionNote: "Late" });
  });
  it("an amendment approved applies the new amount; rejected, the old amount stands and the status resumes", async () => {
    const amendment = { kind: "AMENDMENT", resumeStatus: "APPROVED", previousAmount: "5000.0000", nextAmount: "6000.0000", nextTaxAmount: "300.0000", nextAmountAed: "6000.0000", budgetCheck: "WITHIN_BUDGET", reason: "More screens" };
    mockDb.approvalRequest.findFirst.mockResolvedValue(pendingApproval(amendment));
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "APPROVED" });
    expect(updated().data).toMatchObject({ status: "APPROVED", amount: "6000.0000", taxAmount: "300.0000", amountAed: "6000.0000" });
    // The original decision stays the request's own; the amendment's decision lives on the trail.
    expect(updated().data.decidedByUserId).toBeUndefined();
    expect(updated().data.decisionNote).toBeUndefined();
    expect(mockDb.auditLog.create.mock.calls.map((c) => c[0].data.action)).toContain("AMENDMENT_APPROVED");
    await decideSpendRequest({ organizationId: ORG, decider: lina, source: "ui", approvalRequestId: "ar1", decision: "REJECTED" });
    expect(updated().data).toMatchObject({ status: "APPROVED" });
    expect(updated().data.amount).toBeUndefined();
  });
});

describe("amendSpendRequest", () => {
  const amend = (over: Record<string, unknown> = {}) => amendSpendRequest({ ...base, requestId: "sr1", expectedVersion: 3, amount: "6000", reason: "More screens", ...over });

  it("a rise is routed on the NEW TOTAL with the delta in the payload and the request goes back to pending", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", version: 3, amountAed: "5000" }));
    const r = await amend();
    expect(r.ok).toBe(true);
    const ar = created();
    expect(ar.amountAed).toBe(6000);
    expect(ar.steps.create.assigneeUserId).toBe("lina");
    expect(ar.payload).toMatchObject({ kind: "AMENDMENT", resumeStatus: "APPROVED", previousAmount: "5000.0000", nextAmount: "6000.0000", deltaReporting: "1000.0000", budgetCheck: "WITHIN_BUDGET", reason: "More screens" });
    expect(updated().where).toMatchObject({ id: "sr1", status: "APPROVED", version: 3 });
    expect(updated().data).toMatchObject({ status: "PENDING_APPROVAL", approvalRequestId: "ar1" });
    expect(updated().data.amount).toBeUndefined();
  });
  it("a rise past the line's remaining is an exception to the final approver", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", version: 3, amountAed: "5000" }));
    await amend({ amount: "7000" });
    expect(created().steps.create.assigneeUserId).toBe("medhat");
    expect(created().payload).toMatchObject({ budgetCheck: "OVER_BUDGET", requireFinalApprover: true });
  });
  it("a fall applies at once, scales the AED figure, and is audited with the delta", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "AWAITING_SUPPLIER", version: 3, amountAed: "5000" }));
    const r = await amend({ amount: "4000", taxAmount: "200" });
    expect(r.ok).toBe(true);
    expect(mockDb.approvalRequest.create).not.toHaveBeenCalled();
    expect(updated().where).toMatchObject({ id: "sr1", status: "AWAITING_SUPPLIER", version: 3 });
    expect(updated().data).toMatchObject({ amount: "4000.0000", taxAmount: "200.0000", amountAed: "4000.0000", budgetCheckStatus: "WITHIN_BUDGET" });
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "AMEND", changes: expect.objectContaining({ deltaReporting: "-1000.0000", reason: "More screens" }) });
    // A request lowered back inside the line drops its exception badge.
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", version: 3, amount: "7000", amountAed: "7000", budgetCheckStatus: "OVER_BUDGET" }));
    await amend({ amount: "4000" });
    expect(updated().data.budgetCheckStatus).toBe("WITHIN_BUDGET");
  });
  it("refuses the same amount, a non-requester and a request not yet approved", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", version: 3 }));
    expect(await amend({ amount: "5000" })).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(await amend({ actor: { id: "other", isAdmin: true } })).toMatchObject({ ok: false, code: "NOT_REQUESTER" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    expect(await amend()).toMatchObject({ ok: false, code: "INVALID_STATUS" });
  });
});

describe("transitionSpendRequest and quotes", () => {
  it("withdraw takes a pending submission back to draft, cancelling its approval and clearing the check", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL", approvalRequestId: "ar1", budgetCheckStatus: "WITHIN_BUDGET", version: 2 }));
    mockDb.approvalRequest.findFirst.mockResolvedValue({ payload: { kind: "SUBMISSION" } });
    // The first findMany is cancelPendingApprovals' scan; the read-back after it lists the trail.
    mockDb.approvalRequest.findMany.mockResolvedValueOnce([{ id: "ar1" }]).mockResolvedValue([]);
    const r = await transitionSpendRequest({ ...base, requestId: "sr1", expectedVersion: 2, action: "withdraw" });
    expect(r.ok).toBe(true);
    expect(mockDb.approvalRequest.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["ar1"] }, status: "PENDING" }, data: { status: "CANCELLED" } });
    expect(updated().data).toMatchObject({ status: "DRAFT", approvalRequestId: null, budgetCheckStatus: "NOT_CHECKED", amountAed: null, submittedAt: null });
  });
  it("withdrawing a pending amendment resumes the approved status and keeps the old amount", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL", approvalRequestId: "ar2", version: 4 }));
    mockDb.approvalRequest.findFirst.mockResolvedValue({ payload: { kind: "AMENDMENT", resumeStatus: "AWAITING_SUPPLIER" } });
    await transitionSpendRequest({ ...base, requestId: "sr1", expectedVersion: 4, action: "withdraw" });
    expect(updated().data).toMatchObject({ status: "AWAITING_SUPPLIER", approvalRequestId: null });
    expect(updated().data.budgetCheckStatus).toBeUndefined();
  });
  it("cancel needs a reason, is open to the requester or an admin, and never touches a request with an order", async () => {
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", version: 2 }));
    expect(await transitionSpendRequest({ ...base, requestId: "sr1", expectedVersion: 2, action: "cancel" })).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(await transitionSpendRequest({ ...base, actor: { id: "other", isAdmin: false }, requestId: "sr1", expectedVersion: 2, action: "cancel", reason: "x" })).toMatchObject({ ok: false, code: "NOT_REQUESTER" });
    const r = await transitionSpendRequest({ ...base, actor: { id: "other", isAdmin: true }, requestId: "sr1", expectedVersion: 2, action: "cancel", reason: "Event postponed" });
    expect(r.ok).toBe(true);
    expect(updated().data).toMatchObject({ status: "CANCELLED", cancelReason: "Event postponed" });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "APPROVED", linkedCommitmentId: "po1" }));
    expect(await transitionSpendRequest({ ...base, requestId: "sr1", expectedVersion: 2, action: "cancel", reason: "x" })).toMatchObject({ ok: false, code: "INVALID_STATUS" });
  });
  it("a recommended quote un-recommends the others; quotes attach to a draft only", async () => {
    const r = await addQuote({ ...base, requestId: "sr1", vendorName: " Acme ", amount: "4800", currency: "aed", recommended: true });
    expect(r.ok).toBe(true);
    expect(mockDb.spendRequestQuote.updateMany).toHaveBeenCalledWith({ where: { spendRequestId: "sr1", recommended: true }, data: { recommended: false } });
    expect(mockDb.spendRequestQuote.create.mock.calls[0][0].data).toMatchObject({ vendorName: "Acme", amount: "4800.0000", currency: "AED", recommended: true });
    mockDb.spendRequest.findFirst.mockResolvedValue(request({ status: "PENDING_APPROVAL" }));
    expect(await addQuote({ ...base, requestId: "sr1", vendorName: "Acme", amount: "1", currency: "AED" })).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    // A submit that commits between the read and the write loses the quote rather than gaining one after submission.
    mockDb.spendRequest.findFirst.mockResolvedValue(request());
    mockDb.spendRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await addQuote({ ...base, requestId: "sr1", vendorName: "Acme", amount: "1", currency: "AED" })).toMatchObject({ ok: false, code: "STALE_WRITE" });
  });
});
