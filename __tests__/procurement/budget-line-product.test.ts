/**
 * A budget line linked to a catalogue item: an archived or foreign product is
 * refused BEFORE any transaction, a real one lands on the created row with
 * its SKU in the audit payload, and omitting the field on an edit keeps the
 * existing link (null is the explicit unlink).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    eventBudget: { findUnique: vi.fn(), update: vi.fn() },
    budgetLine: { aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 2 } }), create: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetLine: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    budgetCategory: { findFirst: vi.fn() },
    budgetProduct: { findFirst: vi.fn() },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { mockDb, tx };
});
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown, opts?: unknown) => (mockDb.$transaction as (cb: (t: unknown) => unknown, opts?: unknown) => unknown)(cb, opts),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => ({ createApprovalRequest: vi.fn(), cancelPendingApprovals: vi.fn(), decideApprovalRequest: vi.fn() }));
vi.mock("@/procurement/services/budget-category-service", () => ({ ensureBudgetCategories: vi.fn().mockResolvedValue([]) }));

import { upsertBudgetLine } from "@/procurement/services/budget-service";

const ORG = "org-1";
const draft = { id: "b1", organizationId: ORG, status: "DRAFT", reportingCurrency: "AED", versionNo: 1, version: 1, naCategoryCodes: [], contingencyPercent: "10", contingencyAmount: "0.0000", plannedExpenseTotal: "0.0000", taxTotalPlanned: "0.0000", forecastTotal: "0.0000", lines: undefined };
const base = { organizationId: ORG, actorUserId: "u1", source: "ui" as const, budgetId: "b1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue(draft);
  mockDb.budgetCategory.findFirst.mockResolvedValue({ id: "c-av", code: "AV" });
  tx.eventBudget.findUnique.mockResolvedValue({ id: "b1", contingencyPercent: "10" });
  tx.budgetLine.aggregate.mockResolvedValue({ _max: { sortOrder: 2 } });
  tx.budgetLine.findMany.mockResolvedValue([]);
});

describe("upsertBudgetLine with a catalogue item", () => {
  it("refuses an archived or foreign product before any transaction", async () => {
    mockDb.budgetProduct.findFirst.mockResolvedValue(null);
    const r = await upsertBudgetLine({ ...base, productId: "p-gone", categoryId: "c-av", description: "AV", qty: 1, unitCost: 100 });
    expect(r).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
    expect(mockDb.budgetProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p-gone", organizationId: ORG, isActive: true } }));
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("stores the link on the new line and the SKU in the audit payload", async () => {
    mockDb.budgetProduct.findFirst.mockResolvedValue({ sku: "510301" });
    const r = await upsertBudgetLine({ ...base, productId: "p-av", categoryId: "c-av", description: "Audio Video Equipment Rental", qty: 2, unitCost: 4000 });
    expect(r.ok).toBe(true);
    expect(tx.budgetLine.create.mock.calls[0][0].data).toMatchObject({ productId: "p-av", categoryId: "c-av", planned: "8000.0000" });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: "BudgetLine", action: "CREATE", changes: expect.objectContaining({ productSku: "510301" }) }) }));
  });

  it("an edit that omits the field keeps the link; null unlinks", async () => {
    const existing = { id: "l1", lineKey: "k1", productId: "p-av", product: { id: "p-av", sku: "510301", name: "AV" }, categoryId: "c-av", description: "AV", qty: "1", unitCost: "100", transactionCurrency: "AED", fxRateToReporting: "1", taxRatePercent: null, taxCode: null, serviceStart: null, serviceEnd: null, sortOrder: 0, isContingency: false, deletedAt: null, forecastReason: null };
    mockDb.budgetLine.findFirst.mockResolvedValue(existing);
    await upsertBudgetLine({ ...base, lineId: "l1", unitCost: 150 });
    expect(tx.budgetLine.update.mock.calls[0][0].data).toMatchObject({ productId: "p-av" });
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ productSku: "510301" });
    expect(mockDb.budgetProduct.findFirst).not.toHaveBeenCalled();
    vi.clearAllMocks();
    mockDb.eventBudget.findFirst.mockResolvedValue(draft);
    mockDb.budgetLine.findFirst.mockResolvedValue(existing);
    tx.eventBudget.findUnique.mockResolvedValue({ id: "b1", contingencyPercent: "10" });
    await upsertBudgetLine({ ...base, lineId: "l1", productId: null });
    expect(tx.budgetLine.update.mock.calls[0][0].data).toMatchObject({ productId: null });
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ productSku: null });
  });
});
