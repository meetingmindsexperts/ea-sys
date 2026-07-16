/**
 * CRM product catalog + deal line items.
 *
 * Pins: seed-once, required fields, org-bound catalog edits, and the deal line-item
 * guards — deal AND product both bound to the org, no duplicate product on a deal,
 * name/category snapshotted at add-time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmProduct: { count: vi.fn(), createMany: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), findFirst: vi.fn() },
    crmDealProduct: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    crmDeal: { findFirst: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/crm/lib/crm-activity", () => ({ recordCrmActivity: vi.fn(() => Promise.resolve({})) }));

import { db } from "@/lib/db";
import { recordCrmActivity } from "@/crm/lib/crm-activity";
import {
  ensureCrmProducts,
  createCrmProduct,
  updateCrmProduct,
  addDealProduct,
  removeDealProduct,
} from "@/crm/services/crm-product-service";
import { CRM_PRODUCT_SEED } from "@/crm/lib/crm-products-seed";
import { sumDealProducts, dealProductsMixedCurrency, type CrmDealProductRow } from "@/crm/lib/crm-types";

function line(over: Partial<CrmDealProductRow>): CrmDealProductRow {
  return {
    id: over.id ?? "l",
    productName: "P",
    category: "C",
    unitPrice: over.unitPrice ?? 100,
    currency: over.currency ?? "AED",
    quantity: over.quantity ?? 1,
    createdAt: "2026-07-15",
    ...over,
  };
}

describe("sumDealProducts — never a fake or cross-currency total (review M2)", () => {
  it("sums qty × unitPrice for single-currency lines", () => {
    expect(sumDealProducts([line({ unitPrice: 100, quantity: 2 }), line({ unitPrice: 50, quantity: 1 })])).toBe(250);
  });
  it("returns null (not a partial sum) when any price is redacted", () => {
    expect(sumDealProducts([line({ unitPrice: 100 }), line({ unitPrice: null })])).toBeNull();
  });
  it("returns null when currencies are mixed", () => {
    const lines = [line({ unitPrice: 100, currency: "AED" }), line({ unitPrice: 100, currency: "USD" })];
    expect(dealProductsMixedCurrency(lines)).toBe(true);
    expect(sumDealProducts(lines)).toBeNull();
  });
  it("empty → 0", () => {
    expect(sumDealProducts([])).toBe(0);
  });
});

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(recordCrmActivity).mockResolvedValue({} as never);
});

describe("ensureCrmProducts", () => {
  it("seeds the full catalog when empty", async () => {
    vi.mocked(db.crmProduct.count).mockResolvedValue(0 as never);
    await ensureCrmProducts(ORG);
    const arg = vi.mocked(db.crmProduct.createMany).mock.calls[0][0] as { data: unknown[] };
    expect(arg.data).toHaveLength(CRM_PRODUCT_SEED.length);
    expect(CRM_PRODUCT_SEED.length).toBeGreaterThan(100);
  });
  it("never re-seeds when products exist", async () => {
    vi.mocked(db.crmProduct.count).mockResolvedValue(5 as never);
    await ensureCrmProducts(ORG);
    expect(db.crmProduct.createMany).not.toHaveBeenCalled();
  });
});

describe("createCrmProduct", () => {
  it("requires a name and a category", async () => {
    expect(await createCrmProduct({ ...base, name: " ", category: "Content" })).toMatchObject({ code: "NAME_REQUIRED" });
    expect(await createCrmProduct({ ...base, name: "X", category: " " })).toMatchObject({ code: "CATEGORY_REQUIRED" });
  });
  it("creates at the next sortOrder", async () => {
    vi.mocked(db.$transaction).mockImplementation(async (fn: unknown) =>
      (fn as (tx: unknown) => unknown)({
        crmProduct: {
          aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
          create: vi.fn().mockResolvedValue({ id: "p-1", name: "Gold", category: "Sponsorship", sku: null }),
        },
      }),
    );
    const res = await createCrmProduct({ ...base, name: "Gold", category: "Sponsorship", price: 50000 });
    expect(res.ok).toBe(true);
  });
});

describe("updateCrmProduct — org-bound", () => {
  it("404s a product not in this org", async () => {
    vi.mocked(db.crmProduct.updateMany).mockResolvedValue({ count: 0 } as never);
    expect(await updateCrmProduct({ ...base, productId: "other", name: "X" })).toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});

describe("addDealProduct — the guards", () => {
  const product = { id: "p-1", name: "Sponsorship - Gold", category: "Sponsorship", sku: "SPO10002", price: 50000, currency: "AED" };

  it("404s when the deal isn't in the org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmProduct.findFirst).mockResolvedValue(product as never);
    expect(await addDealProduct({ ...base, dealId: "d-x", crmProductId: "p-1" })).toMatchObject({ code: "DEAL_NOT_FOUND" });
  });

  it("404s when the product isn't in the org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmProduct.findFirst).mockResolvedValue(null as never);
    expect(await addDealProduct({ ...base, dealId: "d-1", crmProductId: "p-x" })).toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("409s a product already on the deal", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmProduct.findFirst).mockResolvedValue(product as never);
    vi.mocked(db.crmDealProduct.findFirst).mockResolvedValue({ id: "existing" } as never);
    expect(await addDealProduct({ ...base, dealId: "d-1", crmProductId: "p-1" })).toMatchObject({ code: "PRODUCT_ALREADY_ON_DEAL" });
    expect(db.crmDealProduct.create).not.toHaveBeenCalled();
  });

  it("snapshots name/category and pre-fills price from the catalog, and records deal history", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmProduct.findFirst).mockResolvedValue(product as never);
    vi.mocked(db.crmDealProduct.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmDealProduct.create).mockResolvedValue({ id: "line-1" } as never);
    const res = await addDealProduct({ ...base, dealId: "d-1", crmProductId: "p-1" });
    expect(res.ok).toBe(true);
    const data = vi.mocked(db.crmDealProduct.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.productName).toBe("Sponsorship - Gold");
    expect(data.category).toBe("Sponsorship");
    expect(Number(data.unitPrice)).toBe(50000); // pre-filled from catalog list price
    expect(recordCrmActivity).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "DEAL", entityId: "d-1", action: "PRODUCT_ADDED" }),
    );
  });
});

describe("removeDealProduct", () => {
  it("404s a line not on the deal", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmDealProduct.findFirst).mockResolvedValue(null as never);
    expect(await removeDealProduct({ ...base, dealId: "d-1", lineId: "x" })).toMatchObject({ code: "LINE_NOT_FOUND" });
  });
  it("deletes and records PRODUCT_REMOVED on the deal", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1" } as never);
    vi.mocked(db.crmDealProduct.findFirst).mockResolvedValue({ id: "line-1", productName: "Gold" } as never);
    vi.mocked(db.crmDealProduct.deleteMany).mockResolvedValue({ count: 1 } as never);
    const res = await removeDealProduct({ ...base, dealId: "d-1", lineId: "line-1" });
    expect(res.ok).toBe(true);
    expect(recordCrmActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "PRODUCT_REMOVED" }));
  });
});
