import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { canViewDealValues } from "@/crm/lib/crm-roles";
import { buildDealWhere } from "@/crm/lib/deal-filters";
import {
  summarizePipeline,
  computeWinLoss,
  sortReps,
  foldMoney,
  REDACTED_MONEY,
  type MoneySum,
  type StageBucketInput,
  type RepRow,
} from "@/crm/lib/reports";

/**
 * GET /api/crm/reports — pipeline summary, win/loss, and a per-rep leaderboard.
 *
 * Honours the same filters as the board (event/owner/date/value) via buildDealWhere,
 * so a report reflects whatever the operator is looking at. Money is finance-gated:
 * a MEMBER gets counts + win-rate but every VALUE comes back null (rendered as "—",
 * never a fabricated 0).
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  const canSeeValues = canViewDealValues(ctx.role, ctx.fromApiKey);

  try {
    const { searchParams } = new URL(req.url);
    const where = buildDealWhere(
      {
        eventId: searchParams.get("eventId"),
        ownerId: searchParams.get("ownerId"),
        dateField: searchParams.get("dateField"),
        from: searchParams.get("from"),
        to: searchParams.get("to"),
        min: searchParams.get("min"),
        max: searchParams.get("max"),
      },
      { organizationId: ctx.organizationId, canSeeValues },
    );

    // Every aggregate ALSO groups by currency (CRM review H2): deals carry
    // per-row currencies, so a sum is only meaningful per currency — the folds
    // below return null + mixed:true rather than adding AED to USD and stamping
    // the result "$".
    const [stages, byStage, wonAgg, lostAgg, byOwner, users] = await Promise.all([
      db.crmPipelineStage.findMany({
        where: { organizationId: ctx.organizationId },
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
        where: { organizationId: ctx.organizationId },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);

    const num = (d: unknown) => (d == null ? 0 : Number(d));
    const fold = (rows: Array<{ currency: string; _sum: { dealValue: unknown } }>): MoneySum =>
      canSeeValues
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
    const repAgg = new Map<string, { ownerId: string | null; openCount: number; wonCount: number; open: typeof byOwner; won: typeof byOwner }>();
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
          ownerName: agg.ownerId ? nameById.get(agg.ownerId) ?? "(unknown)" : "Unassigned",
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

    return NextResponse.json({
      canSeeValues,
      pipeline,
      winLoss,
      reps,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/reports:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not build the report" }, { status: 500 });
  }
}
