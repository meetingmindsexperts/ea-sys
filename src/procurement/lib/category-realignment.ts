/**
 * The one-time move of an organisation's budget categories from the planning
 * buckets of 14 September 2026 (VENUE, FNB, ...) to the chart-of-accounts
 * groups (owner decision, 17 September 2026). Pure: it decides, the service
 * executes in one transaction (scripts/realign-budget-categories.ts).
 *
 * The move is only ever safe while nothing that must keep its figures points
 * at an old category, so the plan REFUSES the whole organisation when a
 * budget line, a spend request, a purchase-order line or a "not applicable"
 * mark uses one, or when a product or template line cannot be placed. It
 * never guesses a destination for money: an old bucket does not map onto one
 * account group (TRAVEL is split between Speakers & Faculty and Hospitality).
 *
 * What moves automatically, because the answer is not a guess:
 *   products        to the group of their account-number SKU;
 *   template lines  only a template whose old-category lines are all blank
 *                   (no quantity, no unit cost), which is what the seed
 *                   created: those lines are replaced by one blank line per
 *                   active chart group.
 * Idempotent: a second run over an aligned organisation plans nothing.
 * Client-safe: no database access.
 */
import {
  accountGroupCode,
  BUDGET_CATEGORY_SEED,
  LEGACY_BUDGET_CATEGORY_CODES,
} from "./budget-categories-seed";

export interface RealignCategory {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  type: "EXPENSE" | "REVENUE";
}
export interface RealignProduct {
  id: string;
  sku: string;
  categoryId: string;
}
export interface RealignTemplateLine {
  id: string;
  categoryId: string;
  defaultQty: unknown;
  defaultUnitCost: unknown;
}
export interface RealignTemplate {
  id: string;
  name: string;
  lines: RealignTemplateLine[];
}
/** What already points at a category and would lose its meaning if the category moved. */
export interface RealignReferences {
  budgetLines: number;
  spendRequests: number;
  commitmentLines: number;
}

export interface RealignInput {
  categories: RealignCategory[];
  products: RealignProduct[];
  templates: RealignTemplate[];
  /** Keyed by category id; absent means nothing references it. */
  references: Map<string, RealignReferences>;
  /** Every budget's "not applicable" codes, flattened. */
  naCategoryCodes: string[];
}

export interface RealignPlan {
  /** Chart groups the organisation does not hold yet, in seed order. */
  createCategories: { code: string; name: string; sortOrder: number; isActive: boolean }[];
  /** Existing seed-coded categories whose position differs from the seed's. */
  sortUpdates: { categoryId: string; code: string; sortOrder: number }[];
  /** Products whose category is not their account group. */
  productMoves: { productId: string; sku: string; fromCode: string; toCode: string }[];
  /** Templates whose blank old-category lines are replaced by one blank line per chart group. */
  templateRebuilds: { templateId: string; name: string; removeLineIds: string[]; addGroupCodes: string[] }[];
  /** Old categories left with nothing pointing at them once the plan runs. */
  deleteCategories: { categoryId: string; code: string }[];
  /** Any entry means the organisation is not touched at all. */
  blocked: string[];
}

const isBlank = (v: unknown) => v === null || v === undefined;

export function planCategoryRealignment(input: RealignInput): RealignPlan {
  const plan: RealignPlan = { createCategories: [], sortUpdates: [], productMoves: [], templateRebuilds: [], deleteCategories: [], blocked: [] };
  const expense = input.categories.filter((c) => c.type === "EXPENSE");
  const byCode = new Map(expense.map((c) => [c.code, c]));
  const byId = new Map(expense.map((c) => [c.id, c]));
  const legacy = expense.filter((c) => LEGACY_BUDGET_CATEGORY_CODES.has(c.code));
  const legacyIds = new Set(legacy.map((c) => c.id));
  const seedCodes = new Set(BUDGET_CATEGORY_SEED.map((s) => s.code));

  BUDGET_CATEGORY_SEED.forEach((s, i) => {
    const cur = byCode.get(s.code);
    if (!cur) plan.createCategories.push({ code: s.code, name: s.name, sortOrder: i, isActive: s.active ?? true });
    else if (cur.sortOrder !== i) plan.sortUpdates.push({ categoryId: cur.id, code: s.code, sortOrder: i });
  });

  for (const c of legacy) {
    const r = input.references.get(c.id);
    if (!r) continue;
    if (r.budgetLines > 0) plan.blocked.push(`${r.budgetLines} budget line(s) use category ${c.code}.`);
    if (r.spendRequests > 0) plan.blocked.push(`${r.spendRequests} spend request(s) use category ${c.code}.`);
    if (r.commitmentLines > 0) plan.blocked.push(`${r.commitmentLines} purchase-order line(s) use category ${c.code}.`);
  }
  const legacyNa = [...new Set(input.naCategoryCodes.filter((code) => LEGACY_BUDGET_CATEGORY_CODES.has(code)))];
  if (legacyNa.length > 0) plan.blocked.push(`A budget marks old categories not applicable: ${legacyNa.join(", ")}.`);

  for (const p of input.products) {
    const group = accountGroupCode(p.sku);
    const from = byId.get(p.categoryId);
    if (group && seedCodes.has(group)) {
      if (from?.code !== group) plan.productMoves.push({ productId: p.id, sku: p.sku, fromCode: from?.code ?? "?", toCode: group });
      continue;
    }
    if (legacyIds.has(p.categoryId)) plan.blocked.push(`Product ${p.sku} is in ${from?.code} and its SKU is not an account number in a chart group.`);
  }

  // One blank line per active chart group, the seed's own template shape.
  const templateGroups = BUDGET_CATEGORY_SEED.filter((s) => !s.isContingency && s.active !== false).map((s) => s.code);
  for (const t of input.templates) {
    const oldLines = t.lines.filter((l) => legacyIds.has(l.categoryId));
    if (oldLines.length === 0) continue;
    if (oldLines.some((l) => !isBlank(l.defaultQty) || !isBlank(l.defaultUnitCost))) {
      plan.blocked.push(`Template "${t.name}" has amounts on lines in old categories; move those lines by hand first.`);
      continue;
    }
    const present = new Set(t.lines.filter((l) => !legacyIds.has(l.categoryId)).map((l) => byId.get(l.categoryId)?.code));
    plan.templateRebuilds.push({ templateId: t.id, name: t.name, removeLineIds: oldLines.map((l) => l.id), addGroupCodes: templateGroups.filter((g) => !present.has(g)) });
  }

  // The contingency category keeps its code; the seed order above moves it to the end.
  for (const c of legacy) plan.deleteCategories.push({ categoryId: c.id, code: c.code });
  return plan;
}

/** Nothing to do: already on the chart and nothing blocked. */
export function isPlanEmpty(plan: RealignPlan): boolean {
  return (
    plan.blocked.length === 0 &&
    plan.createCategories.length === 0 &&
    plan.sortUpdates.length === 0 &&
    plan.productMoves.length === 0 &&
    plan.templateRebuilds.length === 0 &&
    plan.deleteCategories.length === 0
  );
}
