/**
 * createBudget with lines imported from a budget sheet (Oct 28, 2026), pinned
 * at the service so every caller gets the same checks: a product from another
 * organisation or archived is refused before any write, an income account must
 * be one of the organisation's revenue categories, the category always comes
 * from the product (never the caller), and the budget, its lines, its revenue
 * lines and the audit row land in ONE transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx, revenue } = vi.hoisted(() => {
  const tx = {
    eventBudget: { create: vi.fn().mockResolvedValue({ id: "b-new" }), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    budgetLine: { createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    budgetRevenueLine: { createMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    event: { findFirst: vi.fn() },
    eventBudget: { count: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    budgetTemplate: { findFirst: vi.fn() },
    budgetProduct: { findMany: vi.fn() },
    budgetCategory: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  const revenue = {
    ensureRevenueCategories: vi.fn(),
    recomputePlannedRevenue: vi.fn(),
    cloneRevenueLines: vi.fn(),
    readRevenueActuals: vi.fn(),
  };
  return { mockDb, tx, revenue };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown) => (mockDb.$transaction as (cb: (t: unknown) => unknown) => unknown)(cb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/approvals/approvals-service", () => ({ createApprovalRequest: vi.fn(), cancelPendingApprovals: vi.fn(), decideApprovalRequest: vi.fn(), subjectsApprovedBy: vi.fn() }));
vi.mock("@/procurement/services/budget-category-service", () => ({
  ensureBudgetCategories: vi.fn().mockResolvedValue([{ id: "cat-cont", code: "CONTINGENCY" }]),
}));
vi.mock("@/procurement/services/budget-revenue-service", () => revenue);

import { createBudget } from "@/procurement/services/budget-service";

const ORG = "org-1";
const base = { organizationId: ORG, actorUserId: "u1", source: "ui" as const, eventId: "e1", reportingCurrency: "AED" };
const ddr = { productId: "p-ddr", description: "Day Delegate Rate", qty: "300", unitCost: "251.42", taxRatePercent: "5", notes: "Sheet 1.1" };
const billed = { incomeAccount: "440011", description: "Day Delegate Rate", qty: "200", unitAmount: "300", notes: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "e1", code: "OGSC2026", name: "OGSC", eventType: "CONFERENCE" });
  mockDb.eventBudget.count.mockResolvedValue(0);
  mockDb.budgetProduct.findMany.mockResolvedValue([{ id: "p-ddr", categoryId: "cat-venue" }]);
  revenue.ensureRevenueCategories.mockResolvedValue([
    { id: "rev-venue", code: "440011", isActive: true },
    { id: "rev-old", code: "440008", isActive: false },
  ]);
});

describe("createBudget from imported lines", () => {
  it("asks for the organisation's own active products only", async () => {
    await createBudget({ ...base, lines: [ddr] });
    expect(mockDb.budgetProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { organizationId: ORG, id: { in: ["p-ddr"] }, isActive: true, category: { isActive: true, type: "EXPENSE" } },
    }));
  });

  it("refuses a product it did not find (another organisation's, or archived) before any write", async () => {
    mockDb.budgetProduct.findMany.mockResolvedValue([]);
    expect(await createBudget({ ...base, lines: [ddr] })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an income account that is unknown or archived before any write", async () => {
    expect(await createBudget({ ...base, revenueLines: [{ ...billed, incomeAccount: "430099" }] })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
    expect(await createBudget({ ...base, revenueLines: [{ ...billed, incomeAccount: "440008" }] })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a negative amount as INVALID_AMOUNT before any write", async () => {
    expect(await createBudget({ ...base, lines: [{ ...ddr, unitCost: "-1" }] })).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("writes the lines, the revenue lines and the audit row in one transaction, the category from the product", async () => {
    await createBudget({ ...base, importedFrom: "ogsc.csv", lines: [ddr], revenueLines: [billed] });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);

    const written = tx.budgetLine.createMany.mock.calls[0][0].data;
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      budgetId: "b-new", productId: "p-ddr", categoryId: "cat-venue", description: "Day Delegate Rate",
      qty: "300.0000", unitCost: "251.4200", planned: "75426.0000", taxRatePercent: "5", taxAmountPlanned: "3771.3000",
      transactionCurrency: "AED", fxRateToReporting: "1", notes: "Sheet 1.1",
    });
    expect(written[1]).toMatchObject({ isContingency: true, categoryId: "cat-cont" });

    expect(tx.budgetRevenueLine.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ budgetId: "b-new", categoryId: "rev-venue", planned: "60000.0000" })] });
    expect(revenue.recomputePlannedRevenue).toHaveBeenCalledWith(tx, "b-new");
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "CREATE", changes: expect.objectContaining({ importedFrom: "ogsc.csv", importedLines: 1, importedRevenueLines: 1 }) }) });
  });

  it("keeps an ordinary create's audit row free of import fields", async () => {
    await createBudget(base);
    const changes = tx.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).not.toHaveProperty("importedFrom");
    expect(revenue.ensureRevenueCategories).not.toHaveBeenCalled();
    expect(tx.budgetRevenueLine.createMany).not.toHaveBeenCalled();
  });
});

describe("createBudget copying a past budget's plan", () => {
  const source = {
    id: "b-src", eventCode: "OGSC2026", versionNo: 1, reportingCurrency: "AED", contingencyPercent: "3.00", naCategoryCodes: ["510100", "OLDCODE"],
    lines: [
      { productId: "p-ddr", categoryId: "cat-venue", description: "Day Delegate Rate", qty: "300.0000", unitCost: "251.4200", transactionCurrency: "AED", fxRateToReporting: "1", taxRatePercent: null, notes: "Sheet 1.1", category: { isActive: true } },
      { productId: "p-gone", categoryId: "cat-av", description: "AV rental", qty: "1.0000", unitCost: "1000.0000", transactionCurrency: "USD", fxRateToReporting: "3.6725", taxRatePercent: "5.00", notes: null, category: { isActive: true } },
      { productId: null, categoryId: "cat-old", description: "Legacy bucket", qty: "1.0000", unitCost: "50.0000", transactionCurrency: "AED", fxRateToReporting: "1", taxRatePercent: null, notes: null, category: { isActive: false } },
    ],
    revenueLines: [
      { description: "Venue billed", qty: "200.0000", unitAmount: "300.0000", transactionCurrency: "AED", fxRateToReporting: "1", notes: null, category: { code: "440011", isActive: true } },
    ],
  };
  const copyInput = { ...base, eventId: "e2", fromBudgetId: "b-src", priceChangePercent: 10, copyRevenue: true };

  beforeEach(() => {
    mockDb.eventBudget.findFirst.mockReset().mockResolvedValueOnce(source).mockResolvedValue(null);
    // p-gone was archived since: only p-ddr comes back as live.
    mockDb.budgetProduct.findMany.mockResolvedValue([{ id: "p-ddr", categoryId: "cat-venue" }]);
    mockDb.budgetCategory.findMany.mockImplementation(async (q: { where: { code?: unknown } }) => (q.where.code ? [{ code: "510100" }] : [{ id: "cat-av" }]));
  });

  it("reads the source inside this organisation only", async () => {
    await createBudget(copyInput);
    expect(mockDb.eventBudget.findFirst.mock.calls[0][0].where).toEqual({ id: "b-src", organizationId: ORG });
  });

  it("refuses a source in another organisation (not found) and a different currency, before any write", async () => {
    mockDb.eventBudget.findFirst.mockReset().mockResolvedValue(null);
    expect(await createBudget(copyInput)).toMatchObject({ ok: false, code: "BUDGET_NOT_FOUND" });
    mockDb.eventBudget.findFirst.mockReset().mockResolvedValueOnce(source);
    expect(await createBudget({ ...copyInput, reportingCurrency: "USD" })).toMatchObject({ ok: false, code: "CURRENCY_LOCKED" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("copies the plan with the price change, drops an archived product, converts a foreign line, leaves an archived category behind", async () => {
    await createBudget(copyInput);
    const written = tx.budgetLine.createMany.mock.calls[0][0].data;
    expect(written).toHaveLength(3); // two copied lines + the contingency line; the archived category's line is left out
    expect(written[0]).toMatchObject({ productId: "p-ddr", categoryId: "cat-venue", qty: "300.0000", unitCost: "276.5620", planned: "82968.6000", notes: "Sheet 1.1" });
    // USD 1,000 at 3.6725 is AED 3,672.50, +10% is 4,039.75; the product is gone, the category stays.
    expect(written[1]).toMatchObject({ productId: null, categoryId: "cat-av", unitCost: "4039.7500", transactionCurrency: "AED", taxRatePercent: "5", notes: "Copied from USD at 3.6725 to AED" });
    expect(written[2]).toMatchObject({ isContingency: true });
    expect(tx.budgetRevenueLine.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ categoryId: "rev-venue", unitAmount: "330.0000", planned: "66000.0000" })] });
  });

  it("names the source as the benchmark, takes its contingency, and says what it did in notes and audit", async () => {
    await createBudget(copyInput);
    expect(tx.eventBudget.create.mock.calls[0][0].data).toMatchObject({
      benchmarkSourceType: "EA_SYS_BUDGET", benchmarkSourceId: "b-src", contingencyPercent: "3",
      notes: "Copied from OGSC2026 v1 with prices +10%. 1 line was left out: the category or income account is archived.",
    });
    const changes = tx.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toMatchObject({ copiedFrom: { budgetId: "b-src", eventCode: "OGSC2026", versionNo: 1 }, priceChangePercent: 10, skippedLines: 1 });
    expect(changes).not.toHaveProperty("importedFrom");
  });

  it("copies no revenue line when the caller has no finance sight", async () => {
    await createBudget({ ...copyInput, copyRevenue: false });
    expect(tx.budgetRevenueLine.createMany).not.toHaveBeenCalled();
    expect(revenue.ensureRevenueCategories).not.toHaveBeenCalled();
  });

  it("refuses a price change outside -50% to +100%", async () => {
    expect(await createBudget({ ...copyInput, priceChangePercent: 150 })).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("carries the not-applicable marks that are still active categories, so the copy can be submitted (review M2)", async () => {
    await createBudget(copyInput);
    expect(tx.eventBudget.create.mock.calls[0][0].data.naCategoryCodes).toEqual(["510100"]);
  });

  it("drops a product whose category changed or was archived since, keeping the source line's category (review M1)", async () => {
    // Two answers, one per query: the copy's live check (p-ddr now sits in another category) and the resolver's.
    mockDb.budgetProduct.findMany.mockReset()
      .mockResolvedValueOnce([{ id: "p-ddr", categoryId: "cat-moved" }])
      .mockResolvedValue([]);
    mockDb.budgetCategory.findMany.mockImplementation(async (q: { where: { code?: unknown } }) => (q.where.code ? [] : [{ id: "cat-av" }, { id: "cat-venue" }]));
    await createBudget(copyInput);
    const written = tx.budgetLine.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({ productId: null, categoryId: "cat-venue", description: "Day Delegate Rate" });
  });

  it("records what the copy brought on the audit row (review L4)", async () => {
    await createBudget(copyInput);
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({ copiedLines: 2, copiedRevenueLines: 1, copyRevenue: true });
  });
});
