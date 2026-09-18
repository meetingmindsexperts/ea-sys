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

// ── Breakdown: the report grouped by ONE dimension ───────────────────────────
//
// "Deals by pipeline / owner / event / deal type / lost reason / month" is one
// question with one answer shape, so it is ONE function over a minimal deal row,
// not seven groupBy queries with seven shapings. The service fetches the rows
// once (the same `where` as the rest of the report) and hands them here; the
// month dimensions cannot be a database groupBy anyway.
//
// Money follows the rules above: per-currency folding (mixed → null), and a
// caller who may not see values gets REDACTED_MONEY in every bucket.

export const CRM_REPORT_DIMENSIONS = [
  "pipeline",
  "owner",
  "event",
  "dealType",
  "lostReason",
  "expectedCloseMonth",
  "closedMonth",
] as const;

export type CrmReportDimension = (typeof CRM_REPORT_DIMENSIONS)[number];

/** Column heading for each dimension, shared by the page and the MCP text. */
export const CRM_REPORT_DIMENSION_LABELS: Record<CrmReportDimension, string> = {
  pipeline: "Pipeline",
  owner: "Sales rep",
  event: "Event",
  dealType: "Deal type",
  lostReason: "Lost reason",
  expectedCloseMonth: "Expected close (month)",
  closedMonth: "Closed (month)",
};

/** A dimension name from a query param, or null when it is not one. */
export function parseReportDimension(v: string | null | undefined): CrmReportDimension | null {
  const s = v?.trim();
  if (!s) return null;
  return (CRM_REPORT_DIMENSIONS as readonly string[]).includes(s) ? (s as CrmReportDimension) : null;
}

/** Whether a dimension only makes sense over LOST deals. */
export function isLostOnlyDimension(d: CrmReportDimension): boolean {
  return d === "lostReason";
}

/** The minimal deal row the breakdown needs (what the service selects). */
export interface BreakdownDealRow {
  status: CrmReportStatus;
  currency: string;
  dealValue: number | null;
  pipeline: string | null;
  ownerId: string | null;
  eventId: string | null;
  dealTypeId: string | null;
  lostReason: string | null;
  expectedClose: Date | null;
  wonAt: Date | null;
  lostAt: Date | null;
}

/** id → display name lookups the service resolves (the lib never queries). */
export interface BreakdownLabels {
  pipeline?: ReadonlyMap<string, string>;
  owner?: ReadonlyMap<string, string>;
  event?: ReadonlyMap<string, string>;
  dealType?: ReadonlyMap<string, string>;
}

export interface BreakdownRow {
  /** Stable bucket key: the id, enum value, reason text or YYYY-MM; NONE_KEY for "not set". */
  key: string;
  label: string;
  totalCount: number;
  openCount: number;
  openValue: number | null;
  openCurrency: string | null;
  openMixed: boolean;
  wonCount: number;
  wonValue: number | null;
  wonCurrency: string | null;
  wonMixed: boolean;
  lostCount: number;
  lostValue: number | null;
  lostCurrency: string | null;
  lostMixed: boolean;
  /** Won / (Won + Lost) inside this bucket; null when nothing in it has closed. */
  winRate: number | null;
}

export const NONE_KEY = "__none__";

/** UTC month key. UTC on purpose: the date filters cut at UTC day boundaries (M11), and a bucket must agree with the filter that produced its rows. */
function monthKey(d: Date | null): string {
  if (!d) return NONE_KEY;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function bucketKeyFor(row: BreakdownDealRow, dimension: CrmReportDimension): string {
  switch (dimension) {
    case "pipeline":
      return row.pipeline ?? NONE_KEY;
    case "owner":
      return row.ownerId ?? NONE_KEY;
    case "event":
      return row.eventId ?? NONE_KEY;
    case "dealType":
      return row.dealTypeId ?? NONE_KEY;
    case "lostReason": {
      const r = row.lostReason?.trim();
      return r ? r : NONE_KEY;
    }
    case "expectedCloseMonth":
      return monthKey(row.expectedClose);
    case "closedMonth":
      return monthKey(row.status === "WON" ? row.wonAt : row.status === "LOST" ? row.lostAt : null);
  }
}

function bucketLabelFor(key: string, dimension: CrmReportDimension, labels: BreakdownLabels): string {
  if (key === NONE_KEY) {
    switch (dimension) {
      case "pipeline":
        return "No pipeline";
      case "owner":
        return "Unassigned";
      case "event":
        return "No event";
      case "dealType":
        return "No deal type";
      case "lostReason":
        return "No reason given";
      case "expectedCloseMonth":
        return "No expected close";
      case "closedMonth":
        return "No close date";
    }
  }
  switch (dimension) {
    case "pipeline":
      return labels.pipeline?.get(key) ?? key;
    case "owner":
      return labels.owner?.get(key) ?? "(unknown)";
    case "event":
      return labels.event?.get(key) ?? "(unknown event)";
    case "dealType":
      return labels.dealType?.get(key) ?? "(unknown type)";
    case "lostReason":
      return key;
    case "expectedCloseMonth":
    case "closedMonth":
      return monthLabel(key);
  }
}

const MONTH_DIMENSIONS: ReadonlySet<CrmReportDimension> = new Set(["expectedCloseMonth", "closedMonth"]);

/**
 * Group deal rows into breakdown buckets for one dimension.
 *
 * Rows that cannot belong to the dimension are left out rather than lumped into
 * a misleading "not set" bucket: a closed-month view has no place for an OPEN
 * deal, and a lost-reason view counts only LOST deals (an open deal has no lost
 * reason, so a "no reason" bucket holding every open deal would be nonsense).
 *
 * Order: months ascending; every other dimension by deal count descending, then
 * label. The "not set" bucket always comes last.
 */
export function bucketDeals(
  rows: BreakdownDealRow[],
  dimension: CrmReportDimension,
  opts: { canSeeValues: boolean; labels?: BreakdownLabels },
): BreakdownRow[] {
  const labels = opts.labels ?? {};
  const eligible =
    dimension === "closedMonth"
      ? rows.filter((r) => r.status !== "OPEN")
      : dimension === "lostReason"
        ? rows.filter((r) => r.status === "LOST")
        : rows;

  const groups = new Map<string, BreakdownDealRow[]>();
  for (const r of eligible) {
    const key = bucketKeyFor(r, dimension);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const fold = (list: BreakdownDealRow[]): MoneySum =>
    opts.canSeeValues
      ? foldMoney(list.map((r) => ({ currency: r.currency, amount: r.dealValue ?? 0 })))
      : REDACTED_MONEY;

  const out: BreakdownRow[] = [];
  for (const [key, list] of groups) {
    const open = list.filter((r) => r.status === "OPEN");
    const won = list.filter((r) => r.status === "WON");
    const lost = list.filter((r) => r.status === "LOST");
    const o = fold(open);
    const w = fold(won);
    const l = fold(lost);
    out.push({
      key,
      label: bucketLabelFor(key, dimension, labels),
      totalCount: list.length,
      openCount: open.length,
      openValue: o.amount,
      openCurrency: o.currency,
      openMixed: o.mixed,
      wonCount: won.length,
      wonValue: w.amount,
      wonCurrency: w.currency,
      wonMixed: w.mixed,
      lostCount: lost.length,
      lostValue: l.amount,
      lostCurrency: l.currency,
      lostMixed: l.mixed,
      winRate: computeWinLoss({ wonCount: won.length, lostCount: lost.length, wonValue: w.amount, lostValue: l.amount }).winRate,
    });
  }

  const byMonth = MONTH_DIMENSIONS.has(dimension);
  return out.sort((a, b) => {
    if (a.key === NONE_KEY) return 1;
    if (b.key === NONE_KEY) return -1;
    if (byMonth) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    return a.label.localeCompare(b.label);
  });
}
