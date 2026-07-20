/**
 * CRM report assembly — the ONE home for the pipeline/win-loss/leaderboard
 * report (review R2-M9).
 *
 * The pure math lives in `src/crm/lib/reports.ts`; this service owns the
 * queries + shaping that used to live inline in the REST route while the MCP
 * `get_crm_report` tool carried its own thinner re-implementation — the exact
 * cross-caller duplication AGENTS.md rule 1 forbids, and the two had already
 * drifted (the MCP report omitted the open-value rollup, the win rate and the
 * per-rep leaderboard). Both callers now consume THIS.
 *
 * Money honesty is inherited from the lib: every aggregate groups by currency,
 * mixed-currency buckets report null + mixed (never a fabricated cross-currency
 * sum), and a caller who may not see money gets REDACTED_MONEY throughout.
 */
import { db } from "@/lib/db";
import { buildDealWhere, type DealFilterParams } from "@/crm/lib/deal-filters";
import {
  summarizePipeline,
  computeWinLoss,
  sortReps,
  foldMoney,
  REDACTED_MONEY,
  type MoneySum,
  type PipelineSummary,
  type WinLoss,
  type StageBucketInput,
  type RepRow,
} from "@/crm/lib/reports";

export interface CrmReport {
  pipeline: PipelineSummary;
  winLoss: WinLoss;
  reps: RepRow[];
}

export async function buildCrmReport(args: {
  organizationId: string;
  canSeeValues: boolean;
  filters: DealFilterParams;
}): Promise<CrmReport> {
  const where = buildDealWhere(args.filters, {
    organizationId: args.organizationId,
    canSeeValues: args.canSeeValues,
  });

  // Every aggregate ALSO groups by currency (CRM review H2): deals carry
  // per-row currencies, so a sum is only meaningful per currency — the folds
  // below return null + mixed:true rather than adding AED to USD and stamping
  // the result "$".
  const [stages, byStage, wonAgg, lostAgg, byOwner, users] = await Promise.all([
    db.crmPipelineStage.findMany({
      where: { organizationId: args.organizationId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, isTerminal: true },
    }),
    db.crmDeal.groupBy({
      by: ["stageId", "currency"],
      where,
      _count: { _all: true },
      _sum: { dealValue: true },
    }),
    db.crmDeal.groupBy({
      by: ["currency"],
      where: { ...where, status: "WON" },
      _count: { _all: true },
      _sum: { dealValue: true },
    }),
    db.crmDeal.groupBy({
      by: ["currency"],
      where: { ...where, status: "LOST" },
      _count: { _all: true },
      _sum: { dealValue: true },
    }),
    db.crmDeal.groupBy({
      by: ["ownerId", "status", "currency"],
      where,
      _count: { _all: true },
      _sum: { dealValue: true },
    }),
    db.user.findMany({
      where: { organizationId: args.organizationId },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  const num = (d: unknown) => (d == null ? 0 : Number(d));
  const fold = (rows: Array<{ currency: string; _sum: { dealValue: unknown } }>): MoneySum =>
    args.canSeeValues
      ? foldMoney(rows.map((r) => ({ currency: r.currency, amount: num(r._sum.dealValue) })))
      : REDACTED_MONEY;

  // ── Pipeline by stage ─────────────────────────────────────────────────────
  const rowsByStage = new Map<string, typeof byStage>();
  for (const r of byStage) {
    const list = rowsByStage.get(r.stageId) ?? [];
    list.push(r);
    rowsByStage.set(r.stageId, list);
  }
  const stageBuckets: StageBucketInput[] = stages.map((s) => {
    const rows = rowsByStage.get(s.id) ?? [];
    const money = fold(rows);
    return {
      stageId: s.id,
      stageName: s.name,
      isTerminal: s.isTerminal,
      count: rows.reduce((a, r) => a + r._count._all, 0),
      value: money.amount,
      currency: money.currency,
      mixed: money.mixed,
    };
  });
  const pipeline = summarizePipeline(stageBuckets);

  // ── Win / loss ────────────────────────────────────────────────────────────
  const wonMoney = fold(wonAgg);
  const lostMoney = fold(lostAgg);
  const winLoss = computeWinLoss({
    wonCount: wonAgg.reduce((a, r) => a + r._count._all, 0),
    lostCount: lostAgg.reduce((a, r) => a + r._count._all, 0),
    wonValue: wonMoney.amount,
    lostValue: lostMoney.amount,
    wonCurrency: wonMoney.currency,
    lostCurrency: lostMoney.currency,
    wonMixed: wonMoney.mixed,
    lostMixed: lostMoney.mixed,
  });

  // ── By rep ────────────────────────────────────────────────────────────────
  const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
  const repAgg = new Map<
    string,
    { ownerId: string | null; openCount: number; wonCount: number; open: typeof byOwner; won: typeof byOwner }
  >();
  for (const r of byOwner) {
    const key = r.ownerId ?? "__none__";
    const agg = repAgg.get(key) ?? { ownerId: r.ownerId, openCount: 0, wonCount: 0, open: [], won: [] };
    if (r.status === "OPEN") {
      agg.openCount += r._count._all;
      agg.open.push(r);
    } else if (r.status === "WON") {
      agg.wonCount += r._count._all;
      agg.won.push(r);
    }
    repAgg.set(key, agg);
  }
  const reps = sortReps(
    [...repAgg.values()].map((agg): RepRow => {
      const open = fold(agg.open);
      const won = fold(agg.won);
      return {
        ownerId: agg.ownerId,
        ownerName: agg.ownerId ? (nameById.get(agg.ownerId) ?? "(unknown)") : "Unassigned",
        openCount: agg.openCount,
        openValue: open.amount,
        openCurrency: open.currency,
        openMixed: open.mixed,
        wonCount: agg.wonCount,
        wonValue: won.amount,
        wonCurrency: won.currency,
        wonMixed: won.mixed,
      };
    }),
  );

  return { pipeline, winLoss, reps };
}
