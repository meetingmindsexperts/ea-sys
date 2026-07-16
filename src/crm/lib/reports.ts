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

/**
 * A currency-aware money total (CRM review H2). Deals carry per-row currencies,
 * so any SUM over dealValue is only meaningful per currency: `amount` is the sum
 * when every contributing row shares ONE currency; when currencies differ the
 * amount is null and `mixed` is true — "—" (unknown) is a fact, "$550,000" made
 * of AED+USD added together is fiction. Same rule sumDealProducts already follows.
 */
export interface MoneySum {
  amount: number | null;
  currency: string | null;
  mixed: boolean;
}

/** What a money-blind caller gets: no amount, no currency, and no mixed hint. */
export const REDACTED_MONEY: MoneySum = { amount: null, currency: null, mixed: false };

/** Fold per-currency aggregate rows into one honest total. */
export function foldMoney(entries: Array<{ currency: string; amount: number }>): MoneySum {
  const byCurrency = new Map<string, number>();
  for (const e of entries) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0) + e.amount);
  if (byCurrency.size === 0) return { amount: 0, currency: null, mixed: false };
  if (byCurrency.size > 1) return { amount: null, currency: null, mixed: true };
  const [currency, amount] = [...byCurrency.entries()][0]!;
  return { amount, currency, mixed: false };
}

export interface StageBucketInput {
  stageId: string;
  stageName: string;
  isTerminal: boolean;
  count: number;
  /** null when the caller may not see money — or when the bucket mixes currencies. */
  value: number | null;
  /** The bucket's single currency; null when redacted, empty, or mixed. */
  currency: string | null;
  /** True when the bucket holds more than one currency (value is then null). */
  mixed: boolean;
}

export interface PipelineSummary {
  stages: StageBucketInput[];
  openCount: number;
  /** Sum across NON-terminal stages; null if values are redacted or mixed. */
  openValue: number | null;
  openCurrency: string | null;
  openMixed: boolean;
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
  const openCount = open.reduce((a, s) => a + s.count, 0);

  // Any mixed column poisons the total; so do two columns in different currencies.
  const currencies = new Set(
    open.filter((s) => s.value !== null && s.currency !== null).map((s) => s.currency as string),
  );
  const mixed = open.some((s) => s.mixed) || currencies.size > 1;
  if (mixed) {
    return { stages, openCount, openValue: null, openCurrency: null, openMixed: true };
  }

  return {
    stages,
    openCount,
    openValue: sumValues(open.map((s) => s.value)),
    openCurrency: currencies.size === 1 ? [...currencies][0]! : null,
    openMixed: false,
  };
}

export interface WinLossInput {
  wonCount: number;
  lostCount: number;
  wonValue: number | null;
  lostValue: number | null;
  wonCurrency?: string | null;
  lostCurrency?: string | null;
  wonMixed?: boolean;
  lostMixed?: boolean;
}

export interface WinLoss extends WinLossInput {
  /** Won / (Won + Lost), rounded to a whole percent. null when nothing closed. */
  winRate: number | null;
}

export function computeWinLoss(input: WinLossInput): WinLoss {
  const decided = input.wonCount + input.lostCount;
  return {
    wonCurrency: null,
    lostCurrency: null,
    wonMixed: false,
    lostMixed: false,
    ...input,
    winRate: decided === 0 ? null : Math.round((input.wonCount / decided) * 100),
  };
}

export interface RepRow {
  ownerId: string | null;
  ownerName: string;
  openCount: number;
  openValue: number | null;
  openCurrency: string | null;
  openMixed: boolean;
  wonCount: number;
  wonValue: number | null;
  wonCurrency: string | null;
  wonMixed: boolean;
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
