/**
 * The product service with the db mocked: the seed runs once and maps
 * categories by code, an unknown code is skipped and logged rather than
 * failing the seed, a malformed SKU and a duplicate are refused with their
 * codes, and an update is bound to the org.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  budgetProduct: { findMany: vi.fn(), createMany: vi.fn(), aggregate: vi.fn(), create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  budgetCategory: { findFirst: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({}) },
}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: log }));
vi.mock("@/procurement/services/budget-category-service", () => ({
  ensureBudgetCategories: vi.fn().mockResolvedValue([
    { id: "c-av", code: "AV" }, { id: "c-venue", code: "VENUE" }, { id: "c-fnb", code: "FNB" }, { id: "c-mkt", code: "MARKETING" },
    { id: "c-print", code: "PRINT" }, { id: "c-staff", code: "STAFFING" }, { id: "c-misc", code: "MISC" }, { id: "c-travel", code: "TRAVEL" },
    { id: "c-acc", code: "ACCOMMODATION" }, { id: "c-comp", code: "COMPLIANCE" }, { id: "c-tech", code: "TECH" }, { id: "c-fac", code: "FACULTY" },
    { id: "c-regops", code: "REGOPS" },
    // TRANSLATION deliberately absent: the seed must skip its one item, not fail.
  ]),
}));

import { createBudgetProduct, ensureBudgetProducts, updateBudgetProduct } from "@/procurement/services/budget-product-service";
import { BUDGET_PRODUCT_SEED } from "@/procurement/lib/budget-products-seed";

const base = { organizationId: "org-1", actorUserId: "u1", source: "ui" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("ensureBudgetProducts", () => {
  it("returns the existing catalogue untouched when the org already holds one", async () => {
    mockDb.budgetProduct.findMany.mockResolvedValue([{ id: "p1" }]);
    expect(await ensureBudgetProducts("org-1")).toEqual([{ id: "p1" }]);
    expect(mockDb.budgetProduct.createMany).not.toHaveBeenCalled();
  });
  it("seeds once, mapping each item's category code to the org's category id, and skips an unknown code", async () => {
    mockDb.budgetProduct.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "seeded" }]);
    mockDb.budgetProduct.createMany.mockResolvedValue({ count: 202 });
    const out = await ensureBudgetProducts("org-1");
    expect(out).toEqual([{ id: "seeded" }]);
    const call = mockDb.budgetProduct.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(BUDGET_PRODUCT_SEED.length - 1);
    const av = call.data.find((d: { sku: string }) => d.sku === "510301");
    expect(av).toMatchObject({ organizationId: "org-1", categoryId: "c-av", isActive: true });
    expect(call.data.find((d: { sku: string }) => d.sku === "510501")).toMatchObject({ isActive: false });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/products:seed-skipped-unknown-category", skipped: ["510310"] }));
  });
});

describe("createBudgetProduct", () => {
  it("refuses a malformed SKU before touching the db", async () => {
    const r = await createBudgetProduct({ ...base, sku: "bad sku!", name: "x", categoryId: "c-av" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_SKU" });
    expect(mockDb.budgetCategory.findFirst).not.toHaveBeenCalled();
  });
  it("refuses an archived or foreign category", async () => {
    mockDb.budgetCategory.findFirst.mockResolvedValue(null);
    expect(await createBudgetProduct({ ...base, sku: "999", name: "x", categoryId: "gone" })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
  });
  it("creates with the next sortOrder and audits; a duplicate SKU is SKU_TAKEN", async () => {
    mockDb.budgetCategory.findFirst.mockResolvedValue({ id: "c-av", code: "AV" });
    mockDb.budgetProduct.aggregate.mockResolvedValue({ _max: { sortOrder: 202 } });
    mockDb.budgetProduct.create.mockResolvedValue({ id: "p9", sku: "999", name: "New thing", categoryId: "c-av", isActive: true, sortOrder: 203, category: { id: "c-av", code: "AV", name: "AV" } });
    const r = await createBudgetProduct({ ...base, sku: " 999 ", name: " New thing ", categoryId: "c-av" });
    expect(r).toMatchObject({ ok: true, product: { id: "p9" } });
    expect(mockDb.budgetProduct.create.mock.calls[0][0].data).toMatchObject({ sku: "999", name: "New thing", sortOrder: 203 });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: "BudgetProduct", action: "CREATE" }) }));
    mockDb.budgetProduct.create.mockRejectedValue({ code: "P2002" });
    expect(await createBudgetProduct({ ...base, sku: "999", name: "Dup", categoryId: "c-av" })).toMatchObject({ ok: false, code: "SKU_TAKEN" });
  });
});

describe("updateBudgetProduct", () => {
  it("is bound to the org and archives with an ARCHIVE audit row", async () => {
    mockDb.budgetProduct.findFirst
      .mockResolvedValueOnce({ id: "p1", sku: "510301", name: "AV", categoryId: "c-av", isActive: true, sortOrder: 0, category: { id: "c-av", code: "AV", name: "AV" } })
      .mockResolvedValueOnce({ id: "p1", sku: "510301", name: "AV", categoryId: "c-av", isActive: false, sortOrder: 0, category: { id: "c-av", code: "AV", name: "AV" } });
    mockDb.budgetProduct.updateMany.mockResolvedValue({ count: 1 });
    const r = await updateBudgetProduct({ ...base, productId: "p1", isActive: false });
    expect(r).toMatchObject({ ok: true, product: { isActive: false } });
    expect(mockDb.budgetProduct.updateMany).toHaveBeenCalledWith({ where: { id: "p1", organizationId: "org-1" }, data: { isActive: false } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ARCHIVE", entityType: "BudgetProduct" }) }));
  });
  it("a product outside the org is PRODUCT_NOT_FOUND and nothing is written", async () => {
    mockDb.budgetProduct.findFirst.mockResolvedValue(null);
    expect(await updateBudgetProduct({ ...base, productId: "p-foreign", name: "x" })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
    expect(mockDb.budgetProduct.updateMany).not.toHaveBeenCalled();
  });
});
