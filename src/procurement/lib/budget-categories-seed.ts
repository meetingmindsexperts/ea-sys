/**
 * The fixed category list every organisation starts from (spec §5, from the
 * finance team's Doc 2). Codes are STABLE KEYS: every budget line, every
 * archive row and every future QuickBooks account mapping keys on them, and
 * the benchmark comparison across budgets not born from one template matches
 * by code (spec §6c). Names are labels and may be edited; codes never are.
 * Client-safe: constants only.
 */
export interface BudgetCategorySeed {
  code: string;
  name: string;
  /** The contingency line is its own category so a draw on it is a spend request against that line. */
  isContingency?: boolean;
}

export const BUDGET_CATEGORY_SEED: readonly BudgetCategorySeed[] = [
  { code: "VENUE", name: "Venue" },
  { code: "FNB", name: "Food & Beverage" },
  { code: "AV", name: "AV & Production" },
  { code: "FACULTY", name: "Speakers & Faculty" },
  { code: "TRAVEL", name: "Travel" },
  { code: "ACCOMMODATION", name: "Accommodation" },
  { code: "STAFFING", name: "Staffing" },
  { code: "MARKETING", name: "Marketing" },
  { code: "PRINT", name: "Printing & Signage" },
  { code: "REGOPS", name: "Registration Ops" },
  { code: "TECH", name: "Technology" },
  { code: "COMPLIANCE", name: "Compliance & Accreditation" },
  { code: "TRANSLATION", name: "Translation" },
  { code: "MISC", name: "Miscellaneous" },
  { code: "CONTINGENCY", name: "Contingency", isContingency: true },
] as const;

export const CONTINGENCY_CATEGORY_CODE = "CONTINGENCY";
export const BUDGET_CATEGORY_CODE_RE = /^[A-Z0-9]+(?:\.[A-Z0-9]+){0,2}$/;
export const BUDGET_CATEGORY_MAX_DEPTH = 3;
