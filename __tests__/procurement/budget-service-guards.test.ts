/**
 * Guards found by the Sep 14, 2026 lifecycle run on the local prod copy, each
 * pinned at the service so every caller (REST today, MCP later) gets it:
 *  - the contingency line is refused as a reallocation TARGET as well as a
 *    source (recomputeBudgetTotals re-sizes it from the percent, so a move
 *    into it left the source line and landed nowhere), on the request AND
 *    on the apply path a queued request takes;
 *  - a reopen needs a reason (it undoes a close-out and a sign-off).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    eventBudget: { findFirst: vi.fn(), update: vi.fn() },
    budgetLine: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetLine: { findFirst: vi.fn() },
    approvalRequest: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { mockDb, tx };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown, opts?: unknown) => (mockDb.$transaction as (cb: (t: unknown) => unknown, opts?: unknown) => unknown)(cb, opts),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => ({
  createApprovalRequest: vi.fn(),
  cancelPendingApprovals: vi.fn(),
  decideApprovalRequest: vi.fn().mockResolvedValue({ ok: true, request: { id: "req-1" }, step: { id: "s1" } }),
}));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));

import { decideReallocation, reallocateBudget, reopenBudget } from "@/procurement/services/budget-service";

const ORG = "org-1";
const activeBudget = { id: "b1", organizationId: ORG, status: "ACTIVE", reportingCurrency: "AED", versionNo: 1, version: 3, naCategoryCodes: [] };
const actor = { id: "u1", role: "ORGANIZER", organizationId: ORG } as never;
const line = (over: Record<string, unknown>) => ({ id: "l", planned: "1000.0000", approvedPlanned: "1000.0000", reallocatedOut: "0.0000", isContingency: false, description: "Hall hire", qty: "1", unitCost: "1000.0000", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(activeBudget);
  tx.budgetLine.findMany.mockResolvedValue([]);
});

describe("reallocation and the contingency line", () => {
  it("refuses the contingency line as the target at the request, before any transaction", async () => {
    mockDb.budgetLine.findFirst
      .mockResolvedValueOnce(line({ id: "from" }))
      .mockResolvedValueOnce(line({ id: "cont", isContingency: true, description: "Contingency" }));
    const r = await reallocateBudget({ organizationId: ORG, actorUserId: "u1", actor, source: "ui", budgetId: "b1", fromLineKey: "k-from", toLineKey: "k-cont", amount: "100", reason: "probe" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses the contingency line as the source", async () => {
    mockDb.budgetLine.findFirst
      .mockResolvedValueOnce(line({ id: "cont", isContingency: true, description: "Contingency" }))
      .mockResolvedValueOnce(line({ id: "to" }));
    const r = await reallocateBudget({ organizationId: ORG, actorUserId: "u1", actor, source: "ui", budgetId: "b1", fromLineKey: "k-cont", toLineKey: "k-to", amount: "100", reason: "probe" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("a request queued before the guard cannot apply into contingency on approval", async () => {
    mockDb.approvalRequest.findFirst.mockResolvedValue({ id: "req-1", subjectId: "b1", status: "PENDING", payload: { fromLineKey: "k-from", toLineKey: "k-cont", amount: "100.0000" } });
    tx.eventBudget.findFirst.mockResolvedValue({ status: "ACTIVE" });
    tx.budgetLine.findFirst
      .mockResolvedValueOnce(line({ id: "from" }))
      .mockResolvedValueOnce(line({ id: "cont", isContingency: true, description: "Contingency" }));
    const r = await decideReallocation({ organizationId: ORG, decider: { id: "a1", role: "ADMIN", organizationId: ORG, procurementApproveUnlimited: true } as never, source: "ui", requestId: "req-1", decision: "APPROVED" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    // The throw rolls the transaction back: no line was written.
    expect(tx.budgetLine.update).not.toHaveBeenCalled();
  });
});

describe("reopen needs a reason", () => {
  it("refuses a blank reason before reading the budget", async () => {
    const r = await reopenBudget({ organizationId: ORG, actorUserId: "a1", source: "ui", budgetId: "b1", reason: "   " });
    expect(r).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(mockDb.eventBudget.findFirst).not.toHaveBeenCalled();
  });

  it("proceeds to the transition with a reason", async () => {
    mockDb.eventBudget.findFirst.mockResolvedValue(null);
    const r = await reopenBudget({ organizationId: ORG, actorUserId: "a1", source: "ui", budgetId: "b1", reason: "late supplier bill" });
    // The guard passed; the transition itself then reported the (mocked-away) budget as missing.
    expect(r).toMatchObject({ ok: false, code: "BUDGET_NOT_FOUND" });
    expect(mockDb.eventBudget.findFirst).toHaveBeenCalledTimes(1);
  });
});
