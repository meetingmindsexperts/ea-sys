/**
 * Close-out (spec §14 Q13): which lines need a written variance note before
 * the budget closes. The page and the service judge with the SAME rule
 * (`varianceRequiresNote` at the AED-5,000 floor converted at the one
 * reporting-to-AED rate), so what the page highlights is what the close
 * will refuse; the server's 422 with its `lineKeys` stays the truth. Pure
 * and client-safe.
 */
import { AED_PEG_RATES, money, resolveReportingToAedRate, storedString, VARIANCE_NOTE_FLOOR_AED, varianceRequiresNote, type MoneyInput, type RateResolution } from "./money";

/** AED, USD and SAR carry a peg the caller never supplies; EUR and GBP need a rate. */
export function isPeggedToAed(currency: string): boolean {
  return AED_PEG_RATES[currency] !== undefined;
}

export interface VarianceLine {
  lineKey: string;
  planned: MoneyInput;
  actual: MoneyInput;
  isContingency: boolean;
  varianceNote: string | null;
}

export interface VarianceRow {
  lineKey: string;
  /** actual minus planned, 4 dp. */
  variance: string;
  /** Percent of planned, one decimal; null when planned is zero. */
  variancePercent: number | null;
  /** Past the threshold, so the close demands a note (never on the contingency line). */
  needsNote: boolean;
  /** A note is already on the line. */
  hasNote: boolean;
}

export type VarianceResult =
  | { ok: true; rate: Extract<RateResolution, { ok: true }>; floorInReporting: string; rows: VarianceRow[] }
  | { ok: false; rate: Extract<RateResolution, { ok: false }> };

export function varianceRows(lines: readonly VarianceLine[], reportingCurrency: string, reportingToAedRate?: MoneyInput | null): VarianceResult {
  const rate = resolveReportingToAedRate(reportingCurrency, reportingToAedRate);
  if (!rate.ok) return { ok: false, rate };
  const floor = VARIANCE_NOTE_FLOOR_AED.div(rate.rate);
  const rows = lines.map((l) => {
    const planned = money(l.planned);
    const variance = money(l.actual).minus(planned);
    return {
      lineKey: l.lineKey,
      variance: storedString(variance),
      variancePercent: planned.isZero() ? null : Number(variance.div(planned).mul(100).toDecimalPlaces(1).toString()),
      needsNote: !l.isContingency && varianceRequiresNote({ planned, actual: l.actual, floorInReporting: floor }),
      hasNote: !!l.varianceNote?.trim(),
    };
  });
  return { ok: true, rate, floorInReporting: storedString(floor), rows };
}

/** The keys the close will refuse on: a note is needed and neither the line nor the draft carries one. */
export function keysStillNeedingNote(rows: readonly VarianceRow[], drafts: Readonly<Record<string, string>>): string[] {
  return rows.filter((r) => r.needsNote && !r.hasNote && !drafts[r.lineKey]?.trim()).map((r) => r.lineKey);
}
