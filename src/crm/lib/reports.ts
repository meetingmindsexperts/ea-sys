/**
 * CRM report math — PURE, so it is testable and the route stays a thin
 * aggregate-and-shape layer.
 *
 * Money is not this module's concern to GATE (the route decides, via
 * canViewDealValues, whether to pass real values or nulls), but it IS this
 * module's concern to render honestly: a value that is null because the caller
 * may not see it must stay null through every sum, never silently become 0. A
 * redacted total and a genuinely-zero total are different facts.
 */

export type CrmReportStatus = "OPEN" | "WON" | "LOST";

export interface StageBucketInput {
  stageId: string;
  stageName: string;
  isTerminal: boolean;
  count: number;
  /** null when the caller may not see money. */
  value: number | null;
}

export interface PipelineSummary {
  stages: StageBucketInput[];
  openCount: number;
  /** Sum across NON-terminal stages; null if values are redacted. */
  openValue: number | null;
}

/**
 * Sum a list of possibly-redacted values. Returns null if EVERY value is null
 * (i.e. money is redacted), else the sum of the visible ones. It does not coerce
 * a null to 0 — that would fabricate a total.
 */
export function sumValues(values: Array<number | null>): number | null {
  const visible = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (visible.length === 0 && values.some((v) => v === null)) return null;
  return visible.reduce((a, b) => a + b, 0);
}

export function summarizePipeline(stages: StageBucketInput[]): PipelineSummary {
  const open = stages.filter((s) => !s.isTerminal);
  return {
    stages,
    openCount: open.reduce((a, s) => a + s.count, 0),
    openValue: sumValues(open.map((s) => s.value)),
  };
}

export interface WinLossInput {
  wonCount: number;
  lostCount: number;
  wonValue: number | null;
  lostValue: number | null;
}

export interface WinLoss extends WinLossInput {
  /** Won / (Won + Lost), rounded to a whole percent. null when nothing closed. */
  winRate: number | null;
}

export function computeWinLoss(input: WinLossInput): WinLoss {
  const decided = input.wonCount + input.lostCount;
  return {
    ...input,
    winRate: decided === 0 ? null : Math.round((input.wonCount / decided) * 100),
  };
}

export interface RepRow {
  ownerId: string | null;
  ownerName: string;
  openCount: number;
  openValue: number | null;
  wonCount: number;
  wonValue: number | null;
}

/** Sort reps by won value desc (nulls last), then won count — a leaderboard. */
export function sortReps(rows: RepRow[]): RepRow[] {
  return [...rows].sort((a, b) => {
    const av = a.wonValue ?? -1;
    const bv = b.wonValue ?? -1;
    if (bv !== av) return bv - av;
    return b.wonCount - a.wonCount;
  });
}
