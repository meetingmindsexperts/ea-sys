/**
 * A cancelled order sends its request back to the approver (owner decision,
 * 15 September 2026). The approvals primitive and the lock are mocked; what is
 * pinned is the routing on the request's stored figures with the line's other
 * open requests counted, the claim from the cancelled order, and the draft
 * fallback when nobody can take it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const tx = vi.hoisted(() => ({
  spendRequest: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  eventBudget: { findFirst: vi.fn() },
  budgetLine: { findFirst: vi.fn() },
}));
const approvals = vi.hoisted(() => ({ createApprovalRequest: vi.fn() }));
const lock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => approvals);
vi.mock("@/procurement/services/committed-figures", () => ({ lockEventCommitted: lock }));

import { rerouteAfterOrderCancelInTx } from "@/procurement/services/spend-request-reroute";

const ORG = "org-1";
const input = { organizationId: ORG, requestId: "sr1", commitmentId: "c1", commitmentNo: "PO-2026-0002", cancelReason: "Supplier late", source: "ui" as const };
const ordered = (over: Record<string, unknown> = {}) => ({ id: "sr1", requestNo: "PR-2026-0002", requesterUserId: "req", budgetId: "b1", lineKey: "k", amount: "4800", currency: "AED", fxRateToReporting: "1", amountAed: "4800", status: "CONVERTED", linkedCommitmentId: "c1", ...over });
const go = () => rerouteAfterOrderCancelInTx(tx as never, input);

beforeEach(() => {
  vi.clearAllMocks();
  tx.spendRequest.findFirst.mockResolvedValue(ordered());
  tx.spendRequest.findMany.mockResolvedValue([]);
  tx.spendRequest.updateMany.mockResolvedValue({ count: 1 });
  tx.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "ACTIVE", reportingCurrency: "AED" });
  tx.budgetLine.findFirst.mockResolvedValue({ lineKey: "k", planned: "30000", committedOpen: "0", actual: "0" });
  lock.mockResolvedValue({ originId: "b1", versions: [{ id: "b1", status: "ACTIVE" }, { id: "b0", status: "ARCHIVED" }] });
  approvals.createApprovalRequest.mockResolvedValue({ ok: true, request: { id: "ar9" } });
});

describe("rerouteAfterOrderCancelInTx", () => {
  it("routes the request again on its stored figures, with the line's other open requests counted, and takes it from the cancelled order", async () => {
    tx.spendRequest.findMany.mockResolvedValue([{ status: "PENDING_APPROVAL", linkedCommitmentId: null, amount: "26000", fxRateToReporting: "1" }]);
    expect(await go()).toEqual({ status: "PENDING_APPROVAL", approvalRequestId: "ar9", exception: true });
    expect(tx.spendRequest.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: ORG, budgetId: { in: ["b1", "b0"] }, lineKey: "k", id: { not: "sr1" } });
    expect(approvals.createApprovalRequest).toHaveBeenCalledWith(tx, expect.objectContaining({
      subjectType: "SPEND_REQUEST", subjectId: "sr1", amountAed: 4800, requesterUserId: "req", requireFinalApprover: true,
      reason: "Order PO-2026-0002 was cancelled: Supplier late",
      payload: expect.objectContaining({ kind: "SUBMISSION", budgetCheck: "OVER_BUDGET", reportingCurrency: "AED", reportingToAedRate: "1", remainingBefore: "4000.0000" }),
    }));
    expect(tx.spendRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "sr1", organizationId: ORG, status: "CONVERTED", linkedCommitmentId: "c1" },
      data: expect.objectContaining({ status: "PENDING_APPROVAL", linkedCommitmentId: null, approvalRequestId: "ar9", budgetCheckStatus: "OVER_BUDGET", decidedByUserId: null }),
    });
  });
  it("goes back to draft when nobody can approve it, or its budget version no longer takes requests", async () => {
    approvals.createApprovalRequest.mockResolvedValueOnce({ ok: false, code: "NO_APPROVER", message: "No approver covers AED 4,800." });
    expect(await go()).toEqual({ status: "DRAFT", reason: "No approver covers AED 4,800." });
    expect(tx.spendRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: "DRAFT", linkedCommitmentId: null, approvalRequestId: null });
    vi.clearAllMocks();
    tx.spendRequest.findFirst.mockResolvedValue(ordered());
    tx.spendRequest.updateMany.mockResolvedValue({ count: 1 });
    tx.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "ARCHIVED", reportingCurrency: "AED" });
    expect(await go()).toMatchObject({ status: "DRAFT" });
    expect(approvals.createApprovalRequest).not.toHaveBeenCalled();
  });
  it("leaves a request that no longer holds this order alone", async () => {
    tx.spendRequest.findFirst.mockResolvedValue(ordered({ status: "APPROVED", linkedCommitmentId: null }));
    expect(await go()).toEqual({ status: "UNCHANGED" });
    expect(tx.spendRequest.updateMany).not.toHaveBeenCalled();
    expect(approvals.createApprovalRequest).not.toHaveBeenCalled();
  });
  it("a lost claim throws, so the whole cancel rolls back and no approval is left behind", async () => {
    tx.spendRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(go()).rejects.toThrow("STALE");
  });
});
