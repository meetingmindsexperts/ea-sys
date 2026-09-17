/**
 * The product seed and the chart-of-accounts categories (17 September 2026):
 * 203 items from the MME list with unique, well-formed SKUs; every SKU is a
 * cost account whose group is a seeded category; the two contra "discount"
 * items and their groups are archived; and `accountGroupCode` rounds an
 * account down to its group and refuses anything that is not one.
 */
import { describe, it, expect } from "vitest";
import { BUDGET_PRODUCT_SEED, BUDGET_PRODUCT_SKU_RE } from "@/procurement/lib/budget-products-seed";
import {
  accountGroupCode,
  BUDGET_CATEGORY_CODE_RE,
  BUDGET_CATEGORY_SEED,
  CONTINGENCY_CATEGORY_CODE,
  LEGACY_BUDGET_CATEGORY_CODES,
} from "@/procurement/lib/budget-categories-seed";

const bySku = new Map(BUDGET_PRODUCT_SEED.map((p) => [p.sku, p]));
const seedByCode = new Map(BUDGET_CATEGORY_SEED.map((c) => [c.code, c]));

describe("accountGroupCode", () => {
  it.each([
    ["500201", "500200"],
    ["500100", "500100"],
    ["510016", "510000"],
    [" 510316 ", "510300"],
    ["510600", "510600"],
  ])("files %s under %s", (sku, group) => {
    expect(accountGroupCode(sku)).toBe(group);
  });
  it.each(["430005", "440011", "50020", "5002011", "LED-01", "", "5x0201"])("is null for %j, which is not a cost account", (sku) => {
    expect(accountGroupCode(sku)).toBeNull();
  });
});

describe("BUDGET_CATEGORY_SEED", () => {
  it("is the 13 chart groups, Venue, the two archived contra groups and contingency last", () => {
    expect(BUDGET_CATEGORY_SEED.map((c) => c.code)).toEqual([
      "500100", "500200", "500300", "500400", "500500", "500600", "500700", "500800", "500900",
      "510000", "510100", "510200", "510300", "510400", "510500", "510600", CONTINGENCY_CATEGORY_CODE,
    ]);
    expect(BUDGET_CATEGORY_SEED.filter((c) => c.active === false).map((c) => c.code)).toEqual(["510500", "510600"]);
    expect(BUDGET_CATEGORY_SEED.at(-1)?.isContingency).toBe(true);
  });
  it("uses codes the category service accepts and none of the replaced planning buckets", () => {
    for (const c of BUDGET_CATEGORY_SEED) {
      expect(c.code).toMatch(BUDGET_CATEGORY_CODE_RE);
      expect(LEGACY_BUDGET_CATEGORY_CODES.has(c.code)).toBe(false);
    }
  });
});

describe("BUDGET_PRODUCT_SEED", () => {
  it("holds the 203 MME items with unique, well-formed SKUs and non-empty names", () => {
    expect(BUDGET_PRODUCT_SEED).toHaveLength(203);
    expect(bySku.size).toBe(203);
    for (const p of BUDGET_PRODUCT_SEED) {
      expect(p.sku).toMatch(BUDGET_PRODUCT_SKU_RE);
      expect(p.name.trim().length).toBeGreaterThan(0);
    }
  });
  it("files every item under a seeded group that is not contingency", () => {
    for (const p of BUDGET_PRODUCT_SEED) {
      const group = accountGroupCode(p.sku);
      expect(group, p.sku).not.toBeNull();
      const cat = seedByCode.get(group!);
      expect(cat, `${p.sku} -> ${group}`).toBeDefined();
      expect(cat?.isContingency).toBeFalsy();
    }
  });
  it("leaves no active group empty, so every chart group can be budgeted from the catalogue", () => {
    const used = new Set(BUDGET_PRODUCT_SEED.map((p) => accountGroupCode(p.sku)));
    for (const c of BUDGET_CATEGORY_SEED) {
      if (c.isContingency) continue;
      expect(used.has(c.code), c.code).toBe(true);
    }
  });
  it("seeds the two discount contra items archived, in the archived groups, and everything else active", () => {
    expect(bySku.get("510501")?.active).toBe(false);
    expect(bySku.get("510600")?.active).toBe(false);
    expect(BUDGET_PRODUCT_SEED.filter((p) => p.active === false)).toHaveLength(2);
    for (const p of BUDGET_PRODUCT_SEED) {
      const archivedGroup = seedByCode.get(accountGroupCode(p.sku)!)?.active === false;
      expect(p.active === false, p.sku).toBe(archivedGroup);
    }
  });
  it("puts items where the chart of accounts books them", () => {
    expect(accountGroupCode("500201")).toBe("500200"); // Delegate Badges: Delegate & Abstract Management, not print
    expect(bySku.get("500201")?.name).toMatch(/Badges/);
    expect(accountGroupCode("510002")).toBe("510000"); // PCO Management Fee: Project Management & Overheads
    expect(accountGroupCode("510404")).toBe("510400"); // Venue Rental: Venue
  });
  it("never carries an em dash into a name", () => {
    for (const p of BUDGET_PRODUCT_SEED) expect(p.name).not.toMatch(/\u2014/);
  });
});
