import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { createDeal } from "@/crm/services/deal-service";

const createDealSchema = z.object({
  name: z.string().min(1).max(255),
  stageId: z.string().min(1),
  companyId: z.string().min(1).optional().nullable(),
  contactId: z.string().min(1).optional().nullable(),
  eventId: z.string().min(1).optional().nullable(),
  ownerId: z.string().min(1).optional().nullable(),
  dealValue: z.number().nonnegative().max(1_000_000_000).optional().nullable(),
  currency: z.string().length(3).optional(),
  expectedClose: z.coerce.date().optional().nullable(),
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

  try {
    const { searchParams } = new URL(req.url);
    const eventId = searchParams.get("eventId")?.trim();
    const ownerId = searchParams.get("ownerId")?.trim();
    const status = searchParams.get("status")?.trim();

    const deals = await db.crmDeal.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(eventId ? { eventId } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(status === "OPEN" || status === "WON" || status === "LOST" ? { status } : {}),
      },
      select: {
        id: true,
        name: true,
        dealValue: true,
        currency: true,
        stageId: true,
        status: true,
        expectedClose: true,
        wonAt: true,
        lostAt: true,
        lostReason: true,
        sponsorSyncedAt: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true, email: true } },
        event: { select: { id: true, name: true, slug: true } },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        _count: { select: { tasks: true, notes: true } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 1000,
    });

    return NextResponse.json({ deals: redactForCaller(deals, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deals:list-failed",
      organizationId: ctx.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load deals" }, { status: 500 });
  }
}

/** POST /api/crm/deals */
export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

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
}
