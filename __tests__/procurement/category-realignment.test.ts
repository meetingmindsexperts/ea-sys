/**
 * The chart-of-accounts realignment plan (17 September 2026), on the shape
 * production held that day: the 15 seeded planning buckets, the 203 seeded
 * products and three seeded templates of blank lines, no budget. It adds the
 * chart groups, refiles every product by its account number, rebuilds the
 * blank templates and removes the old buckets; it refuses the organisation
 * outright when anything carrying money or a decision points at an old bucket;
 * and a second pass over the result plans nothing.
 */
import { describe, it, expect } from "vitest";
import { accountGroupCode, BUDGET_CATEGORY_SEED, LEGACY_BUDGET_CATEGORY_CODES } from "@/procurement/lib/budget-categories-seed";
import { BUDGET_PRODUCT_SEED } from "@/procurement/lib/budget-products-seed";
import { isPlanEmpty, planCategoryRealignment, type RealignCategory, type RealignInput, type RealignTemplate } from "@/procurement/lib/category-realignment";

const LEGACY_ORDER = ["VENUE", "FNB", "AV", "FACULTY", "TRAVEL", "ACCOMMODATION", "STAFFING", "MARKETING", "PRINT", "REGOPS", "TECH", "COMPLIANCE", "TRANSLATION", "MISC", "CONTINGENCY"];

function productionShape(): RealignInput {
  const categories: RealignCategory[] = LEGACY_ORDER.map((code, i) => ({ id: `old-${code}`, code, name: code, sortOrder: i, type: "EXPENSE" }));
  const products = BUDGET_PRODUCT_SEED.map((p, i) => ({ id: `p${i}`, sku: p.sku, categoryId: `old-${LEGACY_ORDER[i % 14]}` }));
  const templates: RealignTemplate[] = ["Conference", "Webinar", "Hybrid"].map((name) => ({
    id: `t-${name}`,
    name,
    lines: LEGACY_ORDER.slice(0, 14).map((code, i) => ({ id: `${name}-${i}`, categoryId: `old-${code}`, defaultQty: null, defaultUnitCost: null })),
  }));
  return { categories, products, templates, references: new Map(), naCategoryCodes: [] };
}

describe("planCategoryRealignment on the production shape", () => {
  const plan = planCategoryRealignment(productionShape());

  it("is not blocked", () => {
    expect(plan.blocked).toEqual([]);
  });
  it("adds every chart group and moves contingency, which it keeps, to the end", () => {
    expect(plan.createCategories.map((c) => c.code)).toEqual(BUDGET_CATEGORY_SEED.filter((s) => s.code !== "CONTINGENCY").map((s) => s.code));
    expect(plan.createCategories.filter((c) => !c.isActive).map((c) => c.code)).toEqual(["510500", "510600"]);
    expect(plan.sortUpdates).toEqual([{ categoryId: "old-CONTINGENCY", code: "CONTINGENCY", sortOrder: BUDGET_CATEGORY_SEED.length - 1 }]);
  });
  it("refiles all 203 products under their account group", () => {
    expect(plan.productMoves).toHaveLength(203);
    for (const m of plan.productMoves) expect(m.toCode).toBe(accountGroupCode(m.sku));
  });
  it("rebuilds each blank template with one line per active chart group", () => {
    expect(plan.templateRebuilds).toHaveLength(3);
    for (const t of plan.templateRebuilds) {
      expect(t.removeLineIds).toHaveLength(14);
      expect(t.addGroupCodes).toEqual(BUDGET_CATEGORY_SEED.filter((s) => !s.isContingency && s.active !== false).map((s) => s.code));
    }
  });
  it("removes the fourteen planning buckets and nothing else", () => {
    expect(plan.deleteCategories.map((c) => c.code).sort()).toEqual([...LEGACY_BUDGET_CATEGORY_CODES].sort());
  });
});

describe("planCategoryRealignment refusals", () => {
  it("refuses when a budget line, a spend request or a purchase-order line uses an old bucket", () => {
    const input = productionShape();
    input.references.set("old-VENUE", { budgetLines: 2, spendRequests: 1, commitmentLines: 1 });
    expect(planCategoryRealignment(input).blocked).toEqual([
      "2 budget line(s) use category VENUE.",
      "1 spend request(s) use category VENUE.",
      "1 purchase-order line(s) use category VENUE.",
    ]);
  });
  it("refuses when a budget marks an old bucket not applicable, naming each once", () => {
    const input = { ...productionShape(), naCategoryCodes: ["TRAVEL", "500100", "TRAVEL", "PRINT"] };
    expect(planCategoryRealignment(input).blocked).toEqual(["A budget marks old categories not applicable: TRAVEL, PRINT."]);
  });
  it("refuses a product in an old bucket whose SKU is not an account number, but leaves one elsewhere alone", () => {
    const input = productionShape();
    input.categories.push({ id: "own", code: "EXTRAS", name: "Extras", sortOrder: 99, type: "EXPENSE" });
    input.products.push({ id: "px", sku: "LED-01", categoryId: "old-AV" }, { id: "py", sku: "LED-02", categoryId: "own" });
    const plan = planCategoryRealignment(input);
    expect(plan.blocked).toEqual(["Product LED-01 is in AV and its SKU is not an account number in a chart group."]);
    expect(plan.deleteCategories.map((c) => c.code)).not.toContain("EXTRAS");
  });
  it("refuses a template that carries amounts on old-bucket lines", () => {
    const input = productionShape();
    input.templates[0].lines[3].defaultUnitCost = "1500";
    const plan = planCategoryRealignment(input);
    expect(plan.blocked).toEqual(['Template "Conference" has amounts on lines in old categories; move those lines by hand first.']);
    expect(plan.templateRebuilds.map((t) => t.name)).toEqual(["Webinar", "Hybrid"]);
  });
  it("ignores revenue categories entirely", () => {
    const input = productionShape();
    input.categories.push({ id: "rev", code: "TRAVEL", name: "Travel income", sortOrder: 0, type: "REVENUE" });
    expect(planCategoryRealignment(input).deleteCategories.map((c) => c.categoryId)).not.toContain("rev");
  });
});

describe("a second pass", () => {
  it("plans nothing once the organisation is on the chart", () => {
    const categories: RealignCategory[] = BUDGET_CATEGORY_SEED.map((s, i) => ({ id: `new-${s.code}`, code: s.code, name: s.name, sortOrder: i, type: "EXPENSE" }));
    const products = BUDGET_PRODUCT_SEED.map((p, i) => ({ id: `p${i}`, sku: p.sku, categoryId: `new-${accountGroupCode(p.sku)}` }));
    const groups = BUDGET_CATEGORY_SEED.filter((s) => !s.isContingency && s.active !== false);
    const templates = [{ id: "t", name: "Conference", lines: groups.map((g, i) => ({ id: `l${i}`, categoryId: `new-${g.code}`, defaultQty: null, defaultUnitCost: null })) }];
    const plan = planCategoryRealignment({ categories, products, templates, references: new Map(), naCategoryCodes: [] });
    expect(isPlanEmpty(plan)).toBe(true);
  });
});
