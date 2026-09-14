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
    eventBudget: { findFirst: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    budgetLine: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetLine: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
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
const activeBudget = { id: "b1", organizationId: ORG, status: "ACTIVE", reportingCurrency: "AED", versionNo: 1, version: 3, naCategoryCodes: [], contingencyPercent: "10", contingencyAmount: "0.0000", plannedExpenseTotal: "36725.0000", taxTotalPlanned: "0.0000", forecastTotal: "0.0000" };
const actor = { id: "u1", role: "ORGANIZER", organizationId: ORG } as never;
const line = (over: Record<string, unknown>) => ({ id: "l", planned: "1000.0000", approvedPlanned: "1000.0000", reallocatedOut: "0.0000", isContingency: false, description: "Hall hire", qty: "1", unitCost: "1000.0000", fxRateToReporting: "1", taxRatePercent: null, deletedAt: null, ...over });

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
    tx.budgetLine.findFirst.mockResolvedValueOnce({ id: "from" }).mockResolvedValueOnce({ id: "cont" });
    tx.budgetLine.findUnique
      .mockResolvedValueOnce(line({ id: "from" }))
      .mockResolvedValueOnce(line({ id: "cont", isContingency: true, description: "Contingency" }));
    const r = await decideReallocation({ organizationId: ORG, decider: { id: "a1", role: "ADMIN", organizationId: ORG, procurementApproveUnlimited: true } as never, source: "ui", requestId: "req-1", decision: "APPROVED" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    // The throw rolls the transaction back: no line was written.
    expect(tx.budgetLine.update).not.toHaveBeenCalled();
  });
});

describe("reallocation under the row lock", () => {
  /** The caller's pre-check sees the lines as they were; the locked re-read is what the write is judged on. */
  function stage(fromLocked: Record<string, unknown>, toLocked: Record<string, unknown>) {
    mockDb.budgetLine.findFirst
      .mockResolvedValueOnce(line({ id: "from", planned: "36725.0000", approvedPlanned: "36725.0000", reallocatedOut: "0.0000" }))
      .mockResolvedValueOnce(line({ id: "fnb", planned: "0.0000", approvedPlanned: "0.0000", description: "Food & Beverage" }));
    tx.budgetLine.findFirst.mockResolvedValueOnce({ id: "from" }).mockResolvedValueOnce({ id: "fnb" });
    tx.budgetLine.findUnique.mockResolvedValueOnce(fromLocked).mockResolvedValueOnce(toLocked);
  }
  const usdHall = line({ id: "from", planned: "36725.0000", approvedPlanned: "36725.0000", reallocatedOut: "0.0000", fxRateToReporting: "3.6725", taxRatePercent: "5" });
  const aedFnb = line({ id: "fnb", planned: "0.0000", approvedPlanned: "0.0000", fxRateToReporting: "1", taxRatePercent: "5", description: "Food & Beverage" });

  it("locks both rows in id order, re-reads them, and rewrites unit cost in the line's own currency with the tax re-derived", async () => {
    stage(usdHall, aedFnb);
    const r = await reallocateBudget({ organizationId: ORG, actorUserId: "u1", actor, source: "ui", budgetId: "b1", fromLineKey: "k-from", toLineKey: "k-fnb", amount: "1836.25", reason: "Catering quote" });
    expect(r).toMatchObject({ ok: true });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const updates = tx.budgetLine.update.mock.calls.map((c) => c[0]);
    // USD line: 34,888.75 AED planned is 9,500 USD at 3.6725; tax follows the new amount.
    expect(updates[0]).toMatchObject({ where: { id: "from" }, data: { planned: "34888.7500", qty: "1", unitCost: "9500.0000", taxAmountPlanned: "1744.4375", reallocatedOut: "1836.2500" } });
    // AED line: unit cost equals planned at rate 1.
    expect(updates[1]).toMatchObject({ where: { id: "fnb" }, data: { planned: "1836.2500", qty: "1", unitCost: "1836.2500", taxAmountPlanned: "91.8125" } });
  });

  it("judges the 10% on the LOCKED row: a move that landed first pushes this one over the cap, nothing is written", async () => {
    // The caller's read said 0 moved so far; by the time the lock is taken, 3,000 has moved.
    stage({ ...usdHall, reallocatedOut: "3000.0000" }, aedFnb);
    const r = await reallocateBudget({ organizationId: ORG, actorUserId: "u1", actor, source: "ui", budgetId: "b1", fromLineKey: "k-from", toLineKey: "k-fnb", amount: "1836.25", reason: "Catering quote" });
    expect(r).toMatchObject({ ok: false, code: "CAP_EXCEEDED" });
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
