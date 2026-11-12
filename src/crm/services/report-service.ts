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
import { crmEvents } from "@/crm/integrations/events";
import { DEAL_ATTRIBUTION_SELECT, attributedEventId } from "@/crm/lib/deal-attribution";
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
  bucketDeals,
  type BreakdownDealRow,
  type BreakdownRow,
  type CrmReportDimension,
} from "@/crm/lib/reports";
import { CRM_DEAL_PIPELINE_LABELS } from "@/crm/lib/crm-types";

export interface CrmReportBreakdown {
  dimension: CrmReportDimension;
  rows: BreakdownRow[];
}

export interface CrmReport {
  pipeline: PipelineSummary;
  winLoss: WinLoss;
  reps: RepRow[];
  /** The report grouped by ONE dimension (pipeline, rep, event, deal type, lost reason, month); null when none was asked for. */
  breakdown: CrmReportBreakdown | null;
}

/** The scalar columns the breakdown groups on: one narrow read, no relations. */
const BREAKDOWN_SELECT = {
  status: true,
  currency: true,
  dealValue: true,
  pipeline: true,
  ownerId: true,
  // The event a deal counts under needs its project's link too (deal-attribution.ts).
  ...DEAL_ATTRIBUTION_SELECT,
  dealTypeId: true,
  lostReason: true,
  expectedClose: true,
  wonAt: true,
  lostAt: true,
} as const;

export async function buildCrmReport(args: {
  organizationId: string;
  canSeeValues: boolean;
  filters: DealFilterParams;
  /** Group the filtered deals by this dimension as well. Omitted = no breakdown, no extra read. */
  groupBy?: CrmReportDimension | null;
}): Promise<CrmReport> {
  const where = buildDealWhere(args.filters, {
    organizationId: args.organizationId,
    canSeeValues: args.canSeeValues,
  });

  // Every aggregate ALSO groups by currency (CRM review H2): deals carry
  // per-row currencies, so a sum is only meaningful per currency — the folds
  // below return null + mixed:true rather than adding AED to USD and stamping
  // the result "$".
  const groupBy = args.groupBy ?? null;
  const needsEvents = groupBy === "event" || groupBy === "attribution";
  const needsProjects = groupBy === "project" || groupBy === "attribution";
  const [stages, byStage, wonAgg, lostAgg, byOwner, users, breakdownDeals, eventNames, dealTypeNames, projectNames] = await Promise.all([
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
    // The breakdown reads the SAME `where` as every aggregate above, so a bucket
    // total can never disagree with the pipeline total beside it. Fetched only
    // when a dimension was asked for: the plain report costs what it cost.
    groupBy ? db.crmDeal.findMany({ where, select: BREAKDOWN_SELECT }) : Promise.resolve([]),
    // Name lookups are org-bound and fetched only for the dimension in use.
    // Deal types include archived ones: an old deal may still point at one.
    needsEvents
      ? crmEvents.listAll(args.organizationId)
      : Promise.resolve([]),
    groupBy === "dealType"
      ? db.crmDealType.findMany({ where: { organizationId: args.organizationId }, select: { id: true, name: true } })
      : Promise.resolve([]),
    // Projects include archived ones: a finished project's deals still name it.
    needsProjects
      ? db.crmProject.findMany({ where: { organizationId: args.organizationId }, select: { id: true, name: true } })
      : Promise.resolve([]),
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

  // ── Breakdown by one dimension ────────────────────────────────────────────
  let breakdown: CrmReportBreakdown | null = null;
  if (groupBy) {
    const rows: BreakdownDealRow[] = breakdownDeals.map((d) => ({
      status: d.status,
      currency: d.currency,
      dealValue: d.dealValue == null ? null : Number(d.dealValue),
      pipeline: d.pipeline ?? null,
      ownerId: d.ownerId ?? null,
      eventId: attributedEventId(d),
      projectId: d.projectId ?? null,
      dealTypeId: d.dealTypeId ?? null,
      lostReason: d.lostReason ?? null,
      expectedClose: d.expectedClose ?? null,
      wonAt: d.wonAt ?? null,
      lostAt: d.lostAt ?? null,
    }));
    breakdown = {
      dimension: groupBy,
      rows: bucketDeals(rows, groupBy, {
        canSeeValues: args.canSeeValues,
        labels: {
          pipeline: new Map(Object.entries(CRM_DEAL_PIPELINE_LABELS)),
          owner: nameById,
          event: new Map(eventNames.map((e) => [e.id, e.name])),
          project: new Map(projectNames.map((p) => [p.id, p.name])),
          dealType: new Map(dealTypeNames.map((t) => [t.id, t.name])),
        },
      }),
    };
  }

  return { pipeline, winLoss, reps, breakdown };
}

/**
 * CRM Home's two totals: the open pipeline and the win rate, over every deal.
 *
 * Reports is admins only (`crm.reports.view`, Nov 12, 2026) and Home is not
 * (owner: "Reports page only"), so Home reads THIS and never the report. It is
 * a PICK from `buildCrmReport` with no filters, on purpose: a second set of
 * queries would be a second answer to "how much is open", and the tile and the
 * Reports page would one day disagree. What is left out is the point of the
 * key: the stages, the won and lost values, each person's results, the
 * breakdowns and every filter.
 */
export interface CrmReportHeadline {
  pipeline: Pick<PipelineSummary, "openCount" | "openValue" | "openCurrency" | "openMixed">;
  winLoss: Pick<WinLoss, "wonCount" | "lostCount" | "winRate">;
}

export async function buildCrmReportHeadline(args: { organizationId: string; canSeeValues: boolean }): Promise<CrmReportHeadline> {
  const { pipeline, winLoss } = await buildCrmReport({ organizationId: args.organizationId, canSeeValues: args.canSeeValues, filters: {} });
  return {
    pipeline: {
      openCount: pipeline.openCount,
      openValue: pipeline.openValue,
      openCurrency: pipeline.openCurrency,
      openMixed: pipeline.openMixed,
    },
    winLoss: { wonCount: winLoss.wonCount, lostCount: winLoss.lostCount, winRate: winLoss.winRate },
  };
}
