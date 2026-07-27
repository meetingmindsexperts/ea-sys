import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { recordExport } from "@/lib/audit-data-transfer";
import { checkRateLimit } from "@/lib/security";
import { toCsv } from "@/lib/csv-escape";
import { requireCrmRead, redactForCaller } from "@/crm/lib/crm-route";
import { listOrgCrmActivityForExport, parseOrgActivityFilters } from "@/crm/lib/crm-activity";
import {
  activityActionLabel,
  formatActivityChangeSummary,
  CRM_ACTIVITY_ENTITY_LABELS,
  personName,
  type CrmActivityChanges,
} from "@/crm/lib/crm-types";

/**
 * GET /api/crm/activity/export — CSV of the (filtered) org-wide activity log.
 *
 * Honours the same filters as the feed. FINANCE-REDACTED: the payloads are run
 * through redactForCaller BEFORE the Summary column is built, so a money-blind
 * MEMBER's export can't leak a deal value or a prose channel (lostReason/notes)
 * through the summary. Cells escaped via the shared escapeCsvCell (formula-injection
 * safe). Rate-limited — an export is a whole-history read.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-activity-export:org:${ctx.organizationId}`,
    limit: 30,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/activity/export:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many exports — try again shortly", code: "RATE_LIMITED", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const { searchParams } = new URL(req.url);
  const parsed = parseOrgActivityFilters(searchParams, ctx.organizationId);
  if (!parsed.ok) {
    apiLogger.warn({
      msg: "crm/activity/export:bad-entity-type",
      entityType: searchParams.get("entityType"),
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: "entityType must be one of DEAL, COMPANY, CONTACT, TASK", code: "BAD_PARAMS" },
      { status: 400 },
    );
  }

  try {
    const rows = await listOrgCrmActivityForExport(parsed.filters);
    // Redact FIRST, then derive the summary — the summary must not see hidden money.
    const safe = redactForCaller(rows, ctx);

    const header = ["When", "Actor", "Action", "Entity type", "Entity", "Summary"] as const;
    const body = safe.map((r) => [
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      r.actor ? personName(r.actor) : "System",
      activityActionLabel(r.action),
      CRM_ACTIVITY_ENTITY_LABELS[r.entityType] ?? r.entityType,
      r.entityName ?? "(removed)",
      formatActivityChangeSummary({
        action: r.action,
        // crm-activity's JsonValue → the client-safe changes shape the formatter reads.
        changes: (r.changes ?? null) as CrmActivityChanges | null,
      }),
    ]);

    apiLogger.info({
      msg: "crm/activity/export:done",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      count: rows.length,
      filters: {
        actorId: parsed.filters.actorId ?? undefined,
        entityType: parsed.filters.entityType ?? undefined,
        action: parsed.filters.action ?? undefined,
        from: parsed.filters.from?.toISOString(),
        to: parsed.filters.to?.toISOString(),
      },
    });

    recordExport(req, {
      entityType: "CrmActivity",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      source: ctx.fromApiKey ? "api" : "rest",
      rowCount: rows.length,
      format: "csv",
      filters: {
        ...(parsed.filters.actorId ? { actorId: parsed.filters.actorId } : {}),
        ...(parsed.filters.entityType ? { entityType: parsed.filters.entityType } : {}),
        ...(parsed.filters.action ? { action: parsed.filters.action } : {}),
        ...(parsed.filters.from ? { from: parsed.filters.from.toISOString() } : {}),
        ...(parsed.filters.to ? { to: parsed.filters.to.toISOString() } : {}),
      },
    });

    const csv = toCsv([header, ...body]);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="crm-activity-${stamp}.csv"`,
      },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/activity/export:failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not export the activity log" }, { status: 500 });
  }
}
