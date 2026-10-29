/**
 * CRM contact score — auto-computed, deals-only (owner decision, July 21 2026).
 *
 * The score SHOWN is derived on read from the contact's deal involvement, so
 * it can never go stale. Since Oct 29, 2026 a copy is also STORED
 * (CrmContact.score) only so the paged list can sort by it on the server; the
 * SQL twin of this formula is in contact-score-service.ts, and a real-database
 * test holds the two together. The formula is deliberately pipeline-driven —
 * notes/status don't move it:
 *
 *   open deals → 30 for the first, +15 each extra, capped at 60
 *   won deal   → +40 (any number of wins counts once)
 *   total clamped to 0–100
 *
 * Pure + client-safe (no Node/db imports): the API routes compute it from
 * filtered relation counts, and the contact page renders the same breakdown.
 */

export interface ContactScoreInput {
  /** Deals this contact is on with status OPEN (archived deals excluded). */
  openDeals: number;
  /** Deals this contact is on with status WON (archived deals excluded). */
  wonDeals: number;
}

export interface ContactScoreBreakdown {
  openDealPoints: number;
  wonDealPoints: number;
  total: number;
}

// Exported for the SQL twin (contact-score-service.ts), so the numbers live once.
export const FIRST_OPEN_DEAL_POINTS = 30;
export const EXTRA_OPEN_DEAL_POINTS = 15;
export const OPEN_DEAL_CAP = 60;
export const WON_DEAL_POINTS = 40;
export const MAX_SCORE = 100;

export function computeContactScore(input: ContactScoreInput): ContactScoreBreakdown {
  // Defensive floor — a negative count is a caller bug, not a negative score.
  const openDeals = Math.max(0, Math.floor(input.openDeals));
  const wonDeals = Math.max(0, Math.floor(input.wonDeals));

  const openDealPoints =
    openDeals === 0
      ? 0
      : Math.min(OPEN_DEAL_CAP, FIRST_OPEN_DEAL_POINTS + EXTRA_OPEN_DEAL_POINTS * (openDeals - 1));
  const wonDealPoints = wonDeals > 0 ? WON_DEAL_POINTS : 0;

  return {
    openDealPoints,
    wonDealPoints,
    total: Math.min(MAX_SCORE, openDealPoints + wonDealPoints),
  };
}

/** Badge tint for a score — muted for cold, amber warming, emerald hot. */
export function contactScoreColor(total: number): string {
  if (total >= 60) return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (total >= 30) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-600 border-slate-200";
}
