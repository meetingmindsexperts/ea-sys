import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requireCrmRead, redactForCaller } from "@/crm/lib/crm-route";
import { listOrgCrmActivity, parseOrgActivityFilters } from "@/crm/lib/crm-activity";

/**
 * GET /api/crm/activity/feed — the ORG-WIDE change log, newest first, cursor-paged.
 *
 * Powers the CRM "Activity" tab: the whole org's history filterable by user
 * (actorId), timeframe (from/to), entity type and action. Read-gated (same readers
 * as the per-record history, incl. MEMBER) and money-redacted end to end — a
 * `dealValue` diff or a prose field (lostReason/notes) is stripped for a caller who
 * can't see money, so a MEMBER sees THAT a value changed, never the number.
 *
 * Query params: actorId?, entityType? (DEAL|COMPANY|CONTACT|TASK), action?, from?,
 * to?, cursor? (last row id), limit? (default 50, cap 200).
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const { searchParams } = new URL(req.url);
  const parsed = parseOrgActivityFilters(searchParams, ctx.organizationId);
  if (!parsed.ok) {
    apiLogger.warn({
      msg: "crm/activity/feed:bad-entity-type",
      entityType: searchParams.get("entityType"),
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: "entityType must be one of DEAL, COMPANY, CONTACT, TASK", code: "BAD_PARAMS" },
      { status: 400 },
    );
  }

  const cursor = searchParams.get("cursor")?.trim() || null;
  const limitRaw = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  try {
    const { rows, nextCursor } = await listOrgCrmActivity({ ...parsed.filters, cursor, limit });
    // Redact deal money + prose from the change payloads for money-blind callers.
    return NextResponse.json({ activity: redactForCaller(rows, ctx), nextCursor });
  } catch (err) {
    apiLogger.error({
      msg: "crm/activity/feed:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the activity feed" }, { status: 500 });
  }
  });
}
