/**
 * closeBudget: what the signed-off summary records.
 *
 * Owner ruling, 24 Sep 2026: a budget may close while purchase orders are
 * still open (allow, warn, list them). Those orders can still be received
 * afterwards, so the summary has to say what was open at the moment of
 * closing; otherwise a signed-off close-out silently stops describing the
 * budget it signed off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    budgetLine: { update: vi.fn() },
    eventBudget: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eventFinancialSummary: { upsert: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetLine: { findMany: vi.fn() },
    registration: { count: vi.fn().mockResolvedValue(0) },
    budgetRevenueLine: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findUnique: vi.fn().mockResolvedValue({ name: "Test 2026", startDate: new Date("2026-12-28"), eventType: "CONFERENCE" }) },
    commitment: { findMany: vi.fn() },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { mockDb, tx };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown) => mockDb.$transaction(cb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => ({ createApprovalRequest: vi.fn(), decideApprovalRequest: vi.fn(), cancelPendingApprovals: vi.fn() }));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));
vi.mock("@/procurement/services/budget-revenue-service", () => ({
  readRevenueActuals: vi.fn().mockResolvedValue({ total: "0.0000", byAccount: {}, notItemised: "0.0000", noAccount: { amount: "0.0000" }, notConverted: [] }),
  cloneRevenueLines: vi.fn(),
}));

import { closeBudget } from "@/procurement/services/budget-service";

const budget = {
  id: "b1", organizationId: "org-1", eventId: "e1", eventCode: "TEST2026", versionNo: 1, status: "ACTIVE", reportingCurrency: "AED",
  plannedExpenseTotal: "58000", contingencyAmount: "2900", plannedRevenueTotal: "0", targetMarginPercent: null, brand: null,
};
const line = { id: "l1", lineKey: "k1", isContingency: false, planned: "18000", committedTotal: "17636.25", actual: "0", varianceNote: "Held in accounting.", category: { code: "510300" } };
const over = { id: "l2", lineKey: "k2", isContingency: false, planned: "40000", committedTotal: "55000", actual: "0", varianceNote: "Held in accounting.", category: { code: "510200" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(budget);
  mockDb.budgetLine.findMany.mockResolvedValue([line, over]);
  tx.eventBudget.updateMany.mockResolvedValue({ count: 1 });
});

const summaryWritten = () => tx.eventBudget.updateMany.mock.calls[0][0].data.closeOutSummary;

describe("closeBudget: committed beside actual", () => {
  it("records what was ordered next to what was paid, and leaves actual alone", async () => {
    // Owner ruling 24 Sep 2026, "show both, separately". The 510200 line was
    // ordered at 55,000 against 40,000 planned; on actual alone it read as a
    // 40,000 underspend and the event archived as costing nothing.
    mockDb.commitment.findMany.mockResolvedValue([]);
    await closeBudget({ organizationId: "org-1", actorUserId: "u1", source: "ui", budgetId: "b1" });
    const s = summaryWritten();
    expect(s.committedTotal).toBe("72636.2500");
    expect(s.actualTotal).toBe("0.0000");
    expect(s.byCategory["510200"]).toEqual({ planned: "40000.0000", committed: "55000.0000", actual: "0.0000", variance: "-40000.0000" });
    // The archive row carries it too, so later reports are not left with zeros only.
    const archive = tx.eventFinancialSummary.upsert.mock.calls[0][0].create.categoryTotals;
    expect(archive["510300"]).toMatchObject({ committed: "17636.2500" });
  });
});

describe("closeBudget: open orders at the moment of closing", () => {
  it("closes anyway and records every order still open, across the event's versions", async () => {
    mockDb.commitment.findMany.mockResolvedValue([
      { commitmentNo: "PO-2026-0004", currency: "EUR", amount: "200", fulfillmentStatus: "OPEN", supplier: { displayName: "Gulf AV" } },
      { commitmentNo: "PO-2026-0005", currency: "AED", amount: "900", fulfillmentStatus: "PARTIALLY_RECEIVED", supplier: { displayName: "Skyline" } },
    ]);
    await closeBudget({ organizationId: "org-1", actorUserId: "u1", source: "ui", budgetId: "b1" });
    // Asked by EVENT, not by version: an order keeps the version it was issued under.
    expect(mockDb.commitment.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: "org-1", eventCode: "TEST2026", status: "APPROVED", fulfillmentStatus: { not: "RECEIVED" } });
    expect(summaryWritten().openOrdersAtClose).toEqual([
      { commitmentNo: "PO-2026-0004", supplier: "Gulf AV", currency: "EUR", amount: "200.0000", fulfillmentStatus: "OPEN" },
      { commitmentNo: "PO-2026-0005", supplier: "Skyline", currency: "AED", amount: "900.0000", fulfillmentStatus: "PARTIALLY_RECEIVED" },
    ]);
  });

  it("records an empty list when everything arrived", async () => {
    mockDb.commitment.findMany.mockResolvedValue([]);
    await closeBudget({ organizationId: "org-1", actorUserId: "u1", source: "ui", budgetId: "b1" });
    expect(summaryWritten().openOrdersAtClose).toEqual([]);
  });
});
