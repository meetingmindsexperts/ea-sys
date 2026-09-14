/**
 * The product seed: 203 items from the MME list, every SKU unique and well
 * formed, every category a real seed category, the two contra "discount"
 * items archived, and the SKU-group mapping spot-checked where a reader would
 * expect it to land.
 */
import { describe, it, expect } from "vitest";
import { BUDGET_PRODUCT_SEED, BUDGET_PRODUCT_SKU_RE } from "@/procurement/lib/budget-products-seed";
import { BUDGET_CATEGORY_SEED } from "@/procurement/lib/budget-categories-seed";

const bySku = new Map(BUDGET_PRODUCT_SEED.map((p) => [p.sku, p]));

describe("BUDGET_PRODUCT_SEED", () => {
  it("holds the 203 MME items with unique, well-formed SKUs and non-empty names", () => {
    expect(BUDGET_PRODUCT_SEED).toHaveLength(203);
    expect(bySku.size).toBe(203);
    for (const p of BUDGET_PRODUCT_SEED) {
      expect(p.sku).toMatch(BUDGET_PRODUCT_SKU_RE);
      expect(p.name.trim().length).toBeGreaterThan(0);
    }
  });
  it("assigns every item to a seed category other than contingency", () => {
    const codes = new Set(BUDGET_CATEGORY_SEED.filter((c) => !c.isContingency).map((c) => c.code));
    for (const p of BUDGET_PRODUCT_SEED) expect(codes.has(p.category), `${p.sku} -> ${p.category}`).toBe(true);
  });
  it("seeds the two discount contra items archived and everything else active", () => {
    expect(bySku.get("510501")?.active).toBe(false);
    expect(bySku.get("510600")?.active).toBe(false);
    expect(BUDGET_PRODUCT_SEED.filter((p) => p.active === false)).toHaveLength(2);
  });
  it("maps SKU groups where a finance reader expects them", () => {
    expect(bySku.get("500101")?.category).toBe("COMPLIANCE");
    expect(bySku.get("500201")?.category).toBe("PRINT");
    expect(bySku.get("500207")?.category).toBe("TECH");
    expect(bySku.get("500305")?.category).toBe("PRINT");
    expect(bySku.get("500304")?.category).toBe("MARKETING");
    expect(bySku.get("500401")?.category).toBe("STAFFING");
    expect(bySku.get("500503")?.category).toBe("FNB");
    expect(bySku.get("500706")?.category).toBe("ACCOMMODATION");
    expect(bySku.get("500801")?.category).toBe("COMPLIANCE");
    expect(bySku.get("510205")?.category).toBe("FACULTY");
    expect(bySku.get("510301")?.category).toBe("AV");
    expect(bySku.get("510310")?.category).toBe("TRANSLATION");
    expect(bySku.get("510313")?.category).toBe("REGOPS");
    expect(bySku.get("510404")?.category).toBe("VENUE");
  });
  it("never carries an em dash into a name", () => {
    for (const p of BUDGET_PRODUCT_SEED) expect(p.name).not.toMatch(/\u2014/);
  });
});
