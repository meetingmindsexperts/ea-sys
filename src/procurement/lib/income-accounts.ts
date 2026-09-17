/**
 * The income side of the chart of accounts (owner decision, 17 September
 * 2026): the 24 income accounts a budget plans revenue under, and the map from
 * a CRM catalogue product to its income account.
 *
 * A CRM product carries two facts: whether MMG delivers it itself or buys it
 * in (`source`, In-House or Out-Sourced) and its functional `category`. The
 * chart has one income account per pair that exists, so the pair decides the
 * account. Seven products in the CRM catalogue use a pair the chart does not
 * have (In-House Setup & Build; Out-Sourced Communication, Content and Event
 * Management); they map to nothing and show as "no income account" until
 * finance adds the accounts or the products are re-tagged. That is deliberate:
 * a guessed account would make the per-account figures quietly wrong.
 *
 * Revenue categories are REVENUE-type BudgetCategory rows coded by the account
 * number, seeded once per organisation by the revenue service. Client-safe.
 */
export interface IncomeAccount {
  code: string;
  name: string;
}

export const DELEGATE_SALES_ACCOUNT = "430005";

export const INCOME_ACCOUNTS: readonly IncomeAccount[] = [
  { code: "430001", name: "In-House: CME Management" },
  { code: "430002", name: "In-House: Abstract Management" },
  { code: "430003", name: "In-House: Communication" },
  { code: "430004", name: "In-House: Content Development" },
  { code: DELEGATE_SALES_ACCOUNT, name: "In-House: Delegate Sales" },
  { code: "430006", name: "In-House: Design" },
  { code: "430007", name: "In-House: Event Finance" },
  { code: "430008", name: "In-House: Event Hospitality" },
  { code: "430009", name: "In-House: Event Management" },
  { code: "430010", name: "In-House: Exhibition Sales" },
  { code: "430011", name: "In-House: Project Management" },
  { code: "430012", name: "In-House: Sponsorship Sales" },
  { code: "430013", name: "In-House: Virtual Events" },
  { code: "440001", name: "Out-Sourced: CME Accreditation" },
  { code: "440002", name: "Out-Sourced: Endorsements" },
  { code: "440003", name: "Out-Sourced: Event Setup & Build" },
  { code: "440004", name: "Out-Sourced: Event Staffing" },
  { code: "440005", name: "Out-Sourced: Food & Beverage" },
  { code: "440006", name: "Out-Sourced: Giveaways & Trophies" },
  { code: "440007", name: "Out-Sourced: Licensing & Permits" },
  { code: "440008", name: "Out-Sourced: Miscellaneous" },
  { code: "440009", name: "Out-Sourced: Production" },
  { code: "440010", name: "Out-Sourced: Travel Services" },
  { code: "440011", name: "Out-Sourced: Venue Hire" },
] as const;

/** Keyed by the CRM catalogue's category, trimmed and lowercased. */
const IN_HOUSE: Readonly<Record<string, string>> = {
  cme: "430001",
  "abstract management": "430002",
  communication: "430003",
  content: "430004",
  "delegate sales": DELEGATE_SALES_ACCOUNT,
  design: "430006",
  finance: "430007",
  hospitality: "430008",
  "event management": "430009",
  exhibition: "430010",
  "project management": "430011",
  sponsorship: "430012",
  virtual: "430013",
};
const OUTSOURCED: Readonly<Record<string, string>> = {
  cme: "440001",
  endorsements: "440002",
  "setup & build": "440003",
  staffing: "440004",
  "f&b": "440005",
  giveaways: "440006",
  permits: "440007",
  misc: "440008",
  production: "440009",
  travel: "440010",
  "venue hire": "440011",
};

/** The income account a CRM product's money belongs to, or null when the chart has none for its pair. */
export function incomeAccountForCrmProduct(source: "IN_HOUSE" | "OUTSOURCED" | null | undefined, category: string | null | undefined): string | null {
  if (!source || !category) return null;
  const key = category.trim().toLowerCase();
  return (source === "IN_HOUSE" ? IN_HOUSE[key] : OUTSOURCED[key]) ?? null;
}
