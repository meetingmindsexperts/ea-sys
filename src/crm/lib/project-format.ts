/**
 * How a corporate project's days and money read on a screen (Nov 12, 2026).
 * Pure and client-safe.
 */
import { formatDealValue, type CrmProjectDealTotal } from "@/crm/lib/crm-types";

/** A YYYY-MM-DD calendar day in the reader's locale. Read as UTC: it is a day, not a moment. */
function day(ymd: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

/** "3 Mar 2027", "3 Mar 2027 – 5 Mar 2027", or null when the project has no start day. */
export function projectDays(startDate: string | null, endDate: string | null): string | null {
  if (!startDate) return endDate ? day(endDate) : null;
  return endDate && endDate !== startDate ? `${day(startDate)} – ${day(endDate)}` : day(startDate);
}

/**
 * One figure per currency, never added across them. An empty list is a caller
 * who may not see deal values, or a project with no valued deal: both read "—".
 */
export function projectMoney(totals: CrmProjectDealTotal[] | undefined, pick: "open" | "won"): string[] {
  return (totals ?? [])
    .filter((t) => t[pick] > 0)
    .map((t) => formatDealValue(t[pick], t.currency) ?? "")
    .filter(Boolean);
}
