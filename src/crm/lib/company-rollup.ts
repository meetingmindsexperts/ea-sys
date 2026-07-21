/**
 * Company-row rollups for the accounts table (July 21, 2026, owner request):
 * the accumulated deal value and the derived "primary contact".
 *
 * Pure — the route feeds it raw rows, unit tests pin the rules:
 *
 *  - Totals count OPEN + WON deals only (owner decision): pipeline + booked
 *    revenue. LOST is money that never came; archived deals are excluded by
 *    the caller's query.
 *  - Totals are PER CURRENCY, never summed across (the H2 rule everywhere
 *    money is added up in this module: AED + USD stamped "$" is a fabricated
 *    number).
 *  - "Primary contact" is DERIVED, not stored: the person holding the PRIMARY
 *    role on the company's most recent deal, falling back to the company's
 *    most recently added contact. Always current, no schema field to go stale.
 */

export interface RollupPerson {
  id: string;
  firstName: string;
  lastName: string;
}

export interface RollupDeal {
  status: "OPEN" | "WON" | "LOST";
  dealValue: unknown; // Prisma Decimal | string | number | null
  currency: string;
  /** The deal's PRIMARY-role people (the caller passes `take: 1`). */
  contacts?: Array<{ crmContact: RollupPerson | null }>;
}

export interface CompanyDealTotal {
  currency: string;
  total: number;
}

/** Per-currency OPEN+WON totals, largest first. Valueless deals contribute nothing. */
export function companyDealTotals(deals: RollupDeal[]): CompanyDealTotal[] {
  const byCurrency = new Map<string, number>();
  for (const d of deals) {
    if (d.status === "LOST") continue;
    if (d.dealValue === null || d.dealValue === undefined) continue;
    const n = Number(d.dealValue);
    if (!Number.isFinite(n)) continue;
    const currency = d.currency || "USD";
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + n);
  }
  return [...byCurrency.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total || a.currency.localeCompare(b.currency));
}

/**
 * The PRIMARY-role contact on the newest deal (deals must arrive newest-first),
 * else the fallback (the company's newest contact), else null.
 */
export function companyPrimaryContact(
  deals: RollupDeal[],
  fallback: RollupPerson | null | undefined,
): RollupPerson | null {
  for (const d of deals) {
    const primary = d.contacts?.[0]?.crmContact;
    if (primary) return primary;
  }
  return fallback ?? null;
}
