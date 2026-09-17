/**
 * The expense categories every organisation starts from: the cost-of-sales
 * groups of the QuickBooks chart of accounts (owner decision, 17 September
 * 2026). A category's code IS the group's account number, so budget against
 * actual per category totals the same as the profit and loss report per
 * account. Products carry their leaf account number as their SKU, and a
 * product's category is always its account group (`accountGroupCode`).
 *
 * Codes are STABLE KEYS: every budget line, every archive row and the
 * benchmark comparison key on them (spec §6c). Names are labels and may be
 * edited; codes never are.
 *
 * Replaced the 15 planning buckets (VENUE, FNB, AV, ...) of 14 September 2026
 * while production held no budget; `LEGACY_BUDGET_CATEGORY_CODES` exists only
 * for the one-time realignment (scripts/realign-budget-categories.ts).
 *
 * Client-safe: constants only.
 */
export interface BudgetCategorySeed {
  code: string;
  name: string;
  /** The contingency line is its own category so a draw on it is a spend request against that line. */
  isContingency?: boolean;
  /** Seeded archived: contra accounts that exist for the accounting mapping, never something to budget for. */
  active?: boolean;
}

export const CONTINGENCY_CATEGORY_CODE = "CONTINGENCY";

export const BUDGET_CATEGORY_SEED: readonly BudgetCategorySeed[] = [
  { code: "500100", name: "CME Management" },
  { code: "500200", name: "Delegate & Abstract Management" },
  { code: "500300", name: "Design, Marketing & Production" },
  { code: "500400", name: "Events Staff" },
  { code: "500500", name: "Food & Beverage" },
  { code: "500600", name: "Grants, Giveaways & Trophies" },
  { code: "500700", name: "Hospitality & Ground Services" },
  { code: "500800", name: "Licensing & Permits" },
  { code: "500900", name: "Miscellaneous" },
  { code: "510000", name: "Project Management & Overheads" },
  { code: "510100", name: "Scientific Program Development" },
  { code: "510200", name: "Speakers & Faculty" },
  { code: "510300", name: "Technical & Buildup" },
  // Not in the chart export of 17 September 2026 although the products list
  // carries 510401 to 510408; finance is re-sharing the chart. The name is
  // provisional and editable; the code stands.
  { code: "510400", name: "Venue" },
  { code: "510500", name: "Discounts Given - COS", active: false },
  { code: "510600", name: "Discount Given - Cost of Sales", active: false },
  { code: CONTINGENCY_CATEGORY_CODE, name: "Contingency", isContingency: true },
] as const;

/** The planning buckets of 14 September 2026, replaced by the chart groups. Realignment only. */
export const LEGACY_BUDGET_CATEGORY_CODES: ReadonlySet<string> = new Set([
  "VENUE", "FNB", "AV", "FACULTY", "TRAVEL", "ACCOMMODATION", "STAFFING",
  "MARKETING", "PRINT", "REGOPS", "TECH", "COMPLIANCE", "TRANSLATION", "MISC",
]);

export const BUDGET_CATEGORY_CODE_RE = /^[A-Z0-9]+(?:\.[A-Z0-9]+){0,2}$/;
export const BUDGET_CATEGORY_MAX_DEPTH = 3;

/** A cost-of-sales account number: six digits starting with 5. */
const COST_ACCOUNT_RE = /^5\d{5}$/;

/**
 * The account group a cost account belongs to: its number rounded down to the
 * hundred (500201 is in 500200, 510016 is in 510000). Null for anything that
 * is not a cost account number, whose category is then chosen by hand.
 */
export function accountGroupCode(sku: string): string | null {
  const s = sku.trim();
  if (!COST_ACCOUNT_RE.test(s)) return null;
  return String(Math.floor(Number(s) / 100) * 100);
}
