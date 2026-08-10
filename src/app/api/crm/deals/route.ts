import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { z } from "zod";
import { CrmDealPipeline } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { canViewDealValues, canExportCrm } from "@/crm/lib/crm-roles";
import { recordExport } from "@/lib/audit-data-transfer";
import { buildDealWhere } from "@/crm/lib/deal-filters";
import { CRM_DEALS_LIST_CAP, CRM_BULK_READ_AUDIT_ROWS, listMeta } from "@/crm/lib/list-caps";
import { createDeal } from "@/crm/services/deal-service";

const createDealSchema = z.object({
  name: z.string().min(1).max(255),
  stageId: z.string().min(1),
  companyId: z.string().min(1).optional().nullable(),
  // Required — a sponsorship deal must be sold against an event (project).
  eventId: z.string().min(1, "Select the event (project) this deal is for"),
  ownerId: z.string().min(1).optional().nullable(),
  dealValue: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  currency: z.string().length(3).optional(),
  expectedClose: z.coerce.date().optional().nullable(),
  pipeline: z.nativeEnum(CrmDealPipeline).optional().nullable(),
  dealTypeId: z.string().min(1).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(25).optional(),
});

/**
 * GET /api/crm/deals — the board.
 *
 * Filterable by event (the sponsor-pipeline default view: "show me BRIDGES 2026's
 * deals") and by owner. Money is redacted for MEMBER by redactForCaller.
 */
export async function GET(req: Request) {
  const { error, ctx } = await requireCrmRead(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  try {
    const { searchParams } = new URL(req.url);

    // The value filter is finance-gated: MEMBER has values redacted, so MEMBER
    // must not be able to FILTER by value (that would make a redacted number
    // binary-searchable). buildDealWhere drops it unless the caller may see values.
    const where = buildDealWhere(
      {
        eventId: searchParams.get("eventId"),
        ownerId: searchParams.get("ownerId"),
        status: searchParams.get("status"),
        pipeline: searchParams.get("pipeline"),
        dealTypeId: searchParams.get("dealTypeId"),
        dateField: searchParams.get("dateField"),
        from: searchParams.get("from"),
        to: searchParams.get("to"),
        min: searchParams.get("min"),
        max: searchParams.get("max"),
        archived: searchParams.get("archived"),
      },
      { organizationId: ctx.organizationId, canSeeValues: canViewDealValues(ctx.role, ctx.fromApiKey) },
    );

    // The count runs against the SAME `where` — it is the honest total the board
    // reports, so a capped page can never read as "this is the whole pipeline".
    const [deals, total] = await Promise.all([
      db.crmDeal.findMany({
      where,
      select: {
        id: true,
        name: true,
        dealValue: true,
        currency: true,
        stageId: true,
        status: true,
        pipeline: true,
        dealTypeId: true,
        dealType: { select: { id: true, name: true } },
        tags: true,
        expectedClose: true,
        wonAt: true,
        lostAt: true,
        lostReason: true,
        sponsorSyncedAt: true,
        archivedAt: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        // `contacts` is deliberately NOT selected here. The board renders none
        // of it, and it made this LIST a superset of the admin-only CSV export —
        // which carries no contact emails at all — so a role refused the export
        // could still lift every linked person's email and job title out of the
        // board's own request. The deal DETAIL route still returns them, for the
        // one deal you opened. (Review H3.)
        // Project date + location are DERIVED from the linked event (never stored
        // on the deal — no drift). city/country only, per owner: the venue string
        // is deliberately not surfaced here.
        event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, city: true, country: true } },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        _count: { select: { tasks: true, notes: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: CRM_DEALS_LIST_CAP,
      }),
      db.crmDeal.count({ where }),
    ]);

    // A caller who may not EXPORT can still page this endpoint, and no amount of
    // gating changes that — you cannot stop someone reading what they are allowed
    // to read. What was missing was ATTRIBUTION: the export routes write an audit
    // row, this one wrote nothing, so a mass pull left no trace at all. Bulk reads
    // by a non-exporting role are now recorded. Threshold, not every read: a
    // filtered board is ordinary work and must not spam the audit log.
    // Fire-and-forget by contract.
    if (deals.length >= CRM_BULK_READ_AUDIT_ROWS && !canExportCrm(ctx.role, ctx.fromApiKey)) {
      recordExport(req, {
        entityType: "CrmDeal",
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        role: ctx.role,
        rowCount: deals.length,
        format: "json",
        filters: { truncated: total > deals.length, total },
      });
    }

    return NextResponse.json({
      deals: redactForCaller(deals, ctx),
      ...listMeta(total, deals.length),
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deals:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load deals" }, { status: 500 });
  }
  });
}

/** POST /api/crm/deals */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const limit = checkRateLimit({
    key: `crm-deal-create:org:${ctx.organizationId}`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/deals:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "Too many deals created — try again shortly", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = createDealSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals:POST", organizationId: ctx.organizationId });
  }

  const result = await createDeal({
    ...parsed.data,
    // Default the owner to whoever created it — an unowned deal is legal (a user
    // can be deleted) but it should never be the default state of a new one.
    ownerId: parsed.data.ownerId ?? ctx.userId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx) }, { status: 201 });
  });
}
