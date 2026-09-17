/**
 * The revenue service with the db mocked: income-account categories seed once;
 * a planned line is a draft-only write under an active REVENUE category, needs
 * a rate in a foreign currency, keeps the planned total in step and is audited;
 * actuals read only PAID registrations and WON, live deals of the event and org,
 * with the live catalogue product deciding the account; a new version copies
 * the lines under the same line keys.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx } = vi.hoisted(() => {
  const tx = {
    budgetRevenueLine: { update: vi.fn(), create: vi.fn().mockResolvedValue({ id: "r-new" }), delete: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), createMany: vi.fn() },
    eventBudget: { update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const mockDb = {
    eventBudget: { findFirst: vi.fn() },
    budgetCategory: { findMany: vi.fn(), createMany: vi.fn(), findFirst: vi.fn() },
    budgetRevenueLine: { findFirst: vi.fn(), findMany: vi.fn() },
    event: { findFirst: vi.fn() },
    registration: { findMany: vi.fn() },
    crmDeal: { findMany: vi.fn() },
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
  return { mockDb, tx };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (cb: (t: unknown) => unknown) => mockDb.$transaction(cb) }));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: log }));

import { cloneRevenueLines, deleteRevenueLine, ensureRevenueCategories, readRevenueActuals, upsertRevenueLine } from "@/procurement/services/budget-revenue-service";
import { INCOME_ACCOUNTS } from "@/procurement/lib/income-accounts";

const ORG = "org-1";
const base = { organizationId: ORG, actorUserId: "u1", source: "ui" as const, budgetId: "b1" };
const savedLine = { id: "r-new", lineKey: "k", categoryId: "c-430005", description: "Physicians", qty: "200", unitAmount: "1500", transactionCurrency: "AED", fxRateToReporting: "1", fxRateSource: "same-currency", fxRateAsOf: null, planned: "300000", notes: null, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), category: { id: "c-430005", code: "430005", name: "In-House: Delegate Sales" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "DRAFT", reportingCurrency: "AED" });
  mockDb.budgetCategory.findFirst.mockResolvedValue({ id: "c-430005" });
  mockDb.budgetRevenueLine.findFirst.mockResolvedValue(savedLine);
  tx.budgetRevenueLine.aggregate.mockImplementation(({ _sum, _max }: { _sum?: unknown; _max?: unknown }) => Promise.resolve(_sum ? { _sum: { planned: "300000" } } : _max ? { _max: { sortOrder: 2 } } : {}));
  tx.auditLog.create.mockResolvedValue({});
});

describe("ensureRevenueCategories", () => {
  it("leaves an organisation that holds any revenue category alone", async () => {
    mockDb.budgetCategory.findMany.mockResolvedValue([{ id: "x", code: "430005" }]);
    await ensureRevenueCategories(ORG);
    expect(mockDb.budgetCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, type: "REVENUE" } }));
    expect(mockDb.budgetCategory.createMany).not.toHaveBeenCalled();
  });
  it("seeds the 24 income accounts once as REVENUE categories", async () => {
    mockDb.budgetCategory.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "x" }]);
    await ensureRevenueCategories(ORG);
    const call = mockDb.budgetCategory.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(INCOME_ACCOUNTS.length);
    expect(call.data[0]).toMatchObject({ organizationId: ORG, code: "430001", type: "REVENUE", depth: 0 });
  });
});

describe("upsertRevenueLine", () => {
  it("refuses anything but a draft before touching a line", async () => {
    mockDb.eventBudget.findFirst.mockResolvedValue({ id: "b1", status: "ACTIVE", reportingCurrency: "AED" });
    expect(await upsertRevenueLine({ ...base, categoryId: "c-430005", description: "x" })).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
  it("accepts only an active REVENUE category of the org", async () => {
    mockDb.budgetCategory.findFirst.mockResolvedValue(null);
    expect(await upsertRevenueLine({ ...base, categoryId: "c-510400", description: "Venue" })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
    expect(mockDb.budgetCategory.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c-510400", organizationId: ORG, isActive: true, type: "REVENUE" } }));
  });
  it("needs a rate for a foreign-currency line", async () => {
    expect(await upsertRevenueLine({ ...base, categoryId: "c-430005", description: "Physicians", qty: 1, unitAmount: 100, transactionCurrency: "USD" })).toMatchObject({ ok: false, code: "RATE_REQUIRED" });
  });
  it("creates the line with its planned amount, keeps the planned total in step, bumps the version and audits", async () => {
    const r = await upsertRevenueLine({ ...base, categoryId: "c-430005", description: " Physicians ", qty: 200, unitAmount: "1500", transactionCurrency: "USD", fxRateToReporting: "3.6725" });
    expect(r).toMatchObject({ ok: true });
    expect(tx.budgetRevenueLine.create.mock.calls[0][0].data).toMatchObject({ organizationId: ORG, budgetId: "b1", description: "Physicians", planned: "1101750.0000", sortOrder: 3, transactionCurrency: "USD" });
    expect(tx.eventBudget.update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { plannedRevenueTotal: "300000.0000" } });
    expect(tx.eventBudget.update).toHaveBeenCalledWith({ where: { id: "b1" }, data: { version: { increment: 1 } } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: "BudgetRevenueLine", action: "CREATE", changes: expect.objectContaining({ budgetId: "b1", planned: "1101750.0000" }) }) }));
  });
  it("deletes only on a draft and only a line of that budget and org", async () => {
    mockDb.budgetRevenueLine.findFirst.mockResolvedValue({ id: "r1", description: "Physicians" });
    expect(await deleteRevenueLine({ ...base, lineId: "r1" })).toEqual({ ok: true, value: { id: "r1" } });
    expect(mockDb.budgetRevenueLine.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1", budgetId: "b1", organizationId: ORG } }));
    expect(tx.budgetRevenueLine.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });
});

describe("readRevenueActuals", () => {
  it("reads PAID registrations and WON live deals of the event and org, the live product deciding the account", async () => {
    mockDb.event.findFirst.mockResolvedValue({ taxRate: "5" });
    mockDb.registration.findMany.mockResolvedValue([{ originalPrice: "1000", discountAmount: null, refundedAmount: "0", pricingTier: null, ticketType: { price: "1000", currency: "USD" } }]);
    mockDb.crmDeal.findMany.mockResolvedValue([
      { dealValue: "20000", currency: "USD", products: [{ productName: "Gold", category: "Old snapshot", unitPrice: "15000", quantity: 1, currency: "USD", crmProduct: { source: "IN_HOUSE", category: "Sponsorship" } }] },
    ]);
    const a = await readRevenueActuals(ORG, "e1", "USD");
    expect(mockDb.registration.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "e1", event: { organizationId: ORG }, paymentStatus: "PAID" } }));
    expect(mockDb.crmDeal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG, eventId: "e1", status: "WON", archivedAt: null } }));
    expect(a.byAccount).toEqual({ "430005": "1000.0000", "430012": "15000.0000" });
    expect(a.notItemised).toBe("5000.0000");
  });
  it("reads nothing for a budget with no event", async () => {
    const a = await readRevenueActuals(ORG, null, "AED");
    expect(a.total).toBe("0.0000");
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
  });
});

describe("cloneRevenueLines", () => {
  it("copies every line onto the new version under the same line key and totals it", async () => {
    tx.budgetRevenueLine.findMany.mockResolvedValue([{ ...savedLine, lineKey: "stable-1" }]);
    const n = await cloneRevenueLines(tx as never, { organizationId: ORG, fromBudgetId: "b1", toBudgetId: "b2" });
    expect(n).toBe(1);
    expect(tx.budgetRevenueLine.createMany.mock.calls[0][0].data[0]).toMatchObject({ organizationId: ORG, budgetId: "b2", lineKey: "stable-1", categoryId: "c-430005", planned: "300000" });
    expect(tx.eventBudget.update).toHaveBeenCalledWith({ where: { id: "b2" }, data: { plannedRevenueTotal: "300000.0000" } });
  });
});
