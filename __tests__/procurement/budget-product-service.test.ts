/**
 * The product service with the db mocked: the seed runs once and files each
 * item under its account group, a missing group is skipped and logged rather
 * than failing the seed, an account-number SKU goes under its group and a
 * contradicting category is refused (17 September 2026), a malformed SKU and a
 * duplicate are refused with their codes, and an update is bound to the org.
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
  ensureBudgetCategories: vi.fn().mockResolvedValue(
    ["500100", "500200", "500300", "500400", "500500", "500600", "500700", "500800", "500900", "510000", "510100", "510200", "510400", "510500", "510600"]
      // 510300 deliberately absent: the seed must skip its items, not fail.
      .map((code) => ({ id: `c-${code}`, code })),
  ),
}));

import { createBudgetProduct, ensureBudgetProducts, updateBudgetProduct } from "@/procurement/services/budget-product-service";
import { BUDGET_PRODUCT_SEED } from "@/procurement/lib/budget-products-seed";

const base = { organizationId: "org-1", actorUserId: "u1", source: "ui" as const };

/** Category rows keyed by code (the group lookup) and by id (a chosen category). */
const categories: Record<string, { id: string; code: string; name: string; isActive: boolean }> = {
  "510300": { id: "c-510300", code: "510300", name: "Technical & Buildup", isActive: true },
  "510500": { id: "c-510500", code: "510500", name: "Discounts Given - COS", isActive: false },
  "500900": { id: "c-500900", code: "500900", name: "Miscellaneous", isActive: true },
};
function categoryLookup({ where }: { where: { id?: string; code?: string } }) {
  if (where.code) return Promise.resolve(categories[where.code] ?? null);
  const hit = Object.values(categories).find((c) => c.id === where.id && c.isActive);
  return Promise.resolve(hit ? { id: hit.id, code: hit.code } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.budgetCategory.findFirst.mockImplementation(categoryLookup);
});

describe("ensureBudgetProducts", () => {
  it("returns the existing catalogue untouched when the org already holds one", async () => {
    mockDb.budgetProduct.findMany.mockResolvedValue([{ id: "p1" }]);
    expect(await ensureBudgetProducts("org-1")).toEqual([{ id: "p1" }]);
    expect(mockDb.budgetProduct.createMany).not.toHaveBeenCalled();
  });
  it("seeds once, filing each item under its account group, and skips a group the org lacks", async () => {
    mockDb.budgetProduct.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "seeded" }]);
    mockDb.budgetProduct.createMany.mockResolvedValue({ count: 1 });
    const out = await ensureBudgetProducts("org-1");
    expect(out).toEqual([{ id: "seeded" }]);
    const call = mockDb.budgetProduct.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    const technical = BUDGET_PRODUCT_SEED.filter((p) => p.sku.startsWith("5103"));
    expect(call.data).toHaveLength(BUDGET_PRODUCT_SEED.length - technical.length);
    expect(call.data.find((d: { sku: string }) => d.sku === "500201")).toMatchObject({ organizationId: "org-1", categoryId: "c-500200", isActive: true });
    expect(call.data.find((d: { sku: string }) => d.sku === "510002")).toMatchObject({ categoryId: "c-510000" });
    expect(call.data.find((d: { sku: string }) => d.sku === "510501")).toMatchObject({ categoryId: "c-510500", isActive: false });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/products:seed-skipped-unknown-category", skipped: technical.map((p) => p.sku) }));
  });
});

describe("createBudgetProduct", () => {
  const created = (sku: string, categoryId: string) => ({ id: "p9", sku, name: "New thing", categoryId, isActive: true, sortOrder: 203, category: { id: categoryId, code: "x", name: "x" } });
  beforeEach(() => {
    mockDb.budgetProduct.aggregate.mockResolvedValue({ _max: { sortOrder: 202 } });
  });

  it("refuses a malformed SKU before touching the db", async () => {
    const r = await createBudgetProduct({ ...base, sku: "bad sku!", name: "x", categoryId: "c-510300" });
    expect(r).toMatchObject({ ok: false, code: "INVALID_SKU" });
    expect(mockDb.budgetCategory.findFirst).not.toHaveBeenCalled();
  });
  it("files an account-number SKU under its group without being told the category", async () => {
    mockDb.budgetProduct.create.mockResolvedValue(created("510323", "c-510300"));
    const r = await createBudgetProduct({ ...base, sku: "510323", name: "New thing" });
    expect(r).toMatchObject({ ok: true });
    expect(mockDb.budgetCategory.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", code: "510300", type: "EXPENSE" } }));
    expect(mockDb.budgetProduct.create.mock.calls[0][0].data).toMatchObject({ sku: "510323", categoryId: "c-510300", sortOrder: 203 });
  });
  it("refuses a category that contradicts the account group and writes nothing", async () => {
    const r = await createBudgetProduct({ ...base, sku: "510323", name: "New thing", categoryId: "c-500900" });
    expect(r).toMatchObject({ ok: false, code: "CATEGORY_MISMATCH" });
    expect(r.ok ? "" : r.message).toMatch(/510300 Technical & Buildup/);
    expect(mockDb.budgetProduct.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "procurement/products:rejected", code: "CATEGORY_MISMATCH" }));
  });
  it("refuses an account whose group is archived", async () => {
    expect(await createBudgetProduct({ ...base, sku: "510502", name: "x" })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
  });
  it("needs a category for a SKU that is not an account number, and refuses an archived or foreign one", async () => {
    expect(await createBudgetProduct({ ...base, sku: "LED-01", name: "x" })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
    expect(await createBudgetProduct({ ...base, sku: "LED-01", name: "x", categoryId: "gone" })).toMatchObject({ ok: false, code: "CATEGORY_NOT_FOUND" });
    expect(mockDb.budgetProduct.create).not.toHaveBeenCalled();
  });
  it("creates with the next sortOrder and audits; a duplicate SKU is SKU_TAKEN", async () => {
    mockDb.budgetProduct.create.mockResolvedValue(created("999", "c-500900"));
    const r = await createBudgetProduct({ ...base, sku: " 999 ", name: " New thing ", categoryId: "c-500900" });
    expect(r).toMatchObject({ ok: true, product: { id: "p9" } });
    expect(mockDb.budgetProduct.create.mock.calls[0][0].data).toMatchObject({ sku: "999", name: "New thing", sortOrder: 203 });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ entityType: "BudgetProduct", action: "CREATE" }) }));
    mockDb.budgetProduct.create.mockRejectedValue({ code: "P2002" });
    expect(await createBudgetProduct({ ...base, sku: "999", name: "Dup", categoryId: "c-500900" })).toMatchObject({ ok: false, code: "SKU_TAKEN" });
  });
});

describe("updateBudgetProduct", () => {
  it("is bound to the org and archives with an ARCHIVE audit row", async () => {
    mockDb.budgetProduct.findFirst
      .mockResolvedValueOnce({ id: "p1", sku: "510301", name: "AV", categoryId: "c-510300", isActive: true, sortOrder: 0, category: { id: "c-510300", code: "510300", name: "Technical & Buildup" } })
      .mockResolvedValueOnce({ id: "p1", sku: "510301", name: "AV", categoryId: "c-510300", isActive: false, sortOrder: 0, category: { id: "c-510300", code: "510300", name: "Technical & Buildup" } });
    mockDb.budgetProduct.updateMany.mockResolvedValue({ count: 1 });
    const r = await updateBudgetProduct({ ...base, productId: "p1", isActive: false });
    expect(r).toMatchObject({ ok: true, product: { isActive: false } });
    expect(mockDb.budgetProduct.updateMany).toHaveBeenCalledWith({ where: { id: "p1", organizationId: "org-1" }, data: { isActive: false } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "ARCHIVE", entityType: "BudgetProduct" }) }));
  });
  it("will not move an account-number product out of its account group", async () => {
    mockDb.budgetProduct.findFirst.mockResolvedValueOnce({ id: "p1", sku: "510301", name: "AV", categoryId: "c-510300", isActive: true, sortOrder: 0, category: { id: "c-510300", code: "510300", name: "Technical & Buildup" } });
    const r = await updateBudgetProduct({ ...base, productId: "p1", categoryId: "c-500900" });
    expect(r).toMatchObject({ ok: false, code: "CATEGORY_MISMATCH" });
    expect(mockDb.budgetProduct.updateMany).not.toHaveBeenCalled();
  });
  it("a product outside the org is PRODUCT_NOT_FOUND and nothing is written", async () => {
    mockDb.budgetProduct.findFirst.mockResolvedValue(null);
    expect(await updateBudgetProduct({ ...base, productId: "p-foreign", name: "x" })).toMatchObject({ ok: false, code: "PRODUCT_NOT_FOUND" });
    expect(mockDb.budgetProduct.updateMany).not.toHaveBeenCalled();
  });
});
