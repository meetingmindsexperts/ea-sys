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
  sumValues,
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

    const [stages, byStage, wonAgg, lostAgg, byOwner, users] = await Promise.all([
      db.crmPipelineStage.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, isTerminal: true },
      }),
      db.crmDeal.groupBy({
        by: ["stageId"],
        where,
        _count: { _all: true },
        _sum: { dealValue: true },
      }),
      db.crmDeal.aggregate({
        where: { ...where, status: "WON" },
        _count: { _all: true },
        _sum: { dealValue: true },
      }),
      db.crmDeal.aggregate({
        where: { ...where, status: "LOST" },
        _count: { _all: true },
        _sum: { dealValue: true },
      }),
      db.crmDeal.groupBy({
        by: ["ownerId", "status"],
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
    const val = (d: unknown) => (canSeeValues ? num(d) : null);

    // ── Pipeline by stage ─────────────────────────────────────────────────────
    const countByStage = new Map(byStage.map((r) => [r.stageId, r]));
    const stageBuckets: StageBucketInput[] = stages.map((s) => {
      const row = countByStage.get(s.id);
      return {
        stageId: s.id,
        stageName: s.name,
        isTerminal: s.isTerminal,
        count: row?._count._all ?? 0,
        value: row ? val(row._sum.dealValue) : canSeeValues ? 0 : null,
      };
    });
    const pipeline = summarizePipeline(stageBuckets);

    // ── Win / loss ────────────────────────────────────────────────────────────
    const winLoss = computeWinLoss({
      wonCount: wonAgg._count._all,
      lostCount: lostAgg._count._all,
      wonValue: val(wonAgg._sum.dealValue),
      lostValue: val(lostAgg._sum.dealValue),
    });

    // ── By rep ────────────────────────────────────────────────────────────────
    const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));
    const repMap = new Map<string, RepRow>();
    for (const r of byOwner) {
      const key = r.ownerId ?? "__none__";
      const existing =
        repMap.get(key) ??
        ({
          ownerId: r.ownerId,
          ownerName: r.ownerId ? nameById.get(r.ownerId) ?? "(unknown)" : "Unassigned",
          openCount: 0,
          openValue: canSeeValues ? 0 : null,
          wonCount: 0,
          wonValue: canSeeValues ? 0 : null,
        } as RepRow);

      const v = val(r._sum.dealValue);
      if (r.status === "OPEN") {
        existing.openCount += r._count._all;
        existing.openValue = sumValues([existing.openValue, v]);
      } else if (r.status === "WON") {
        existing.wonCount += r._count._all;
        existing.wonValue = sumValues([existing.wonValue, v]);
      }
      repMap.set(key, existing);
    }
    const reps = sortReps([...repMap.values()]);

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
