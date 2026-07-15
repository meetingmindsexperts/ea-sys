import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateDeal } from "@/crm/services/deal-service";

const updateDealSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  companyId: z.string().min(1).nullable().optional(),
  contactId: z.string().min(1).nullable().optional(),
  eventId: z.string().min(1).nullable().optional(),
  ownerId: z.string().min(1).nullable().optional(),
  dealValue: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  currency: z.string().length(3).optional(),
  expectedClose: z.coerce.date().nullable().optional(),
});

/** GET /api/crm/deals/[dealId] — detail, with its notes + tasks. */
export async function GET(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmRead(req), params]);
  if (error) return error;

  try {
    // Bound to the org — a deal id from another tenant must 404, not resolve.
    const deal = await db.crmDeal.findFirst({
      where: { id: dealId, organizationId: ctx.organizationId },
      include: {
        company: { select: { id: true, name: true } },
        contacts: {
          include: {
            crmContact: { select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, phone: true } },
          },
        },
        event: { select: { id: true, name: true, slug: true } },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        stage: { select: { id: true, name: true, isTerminal: true } },
        tasks: { orderBy: { dueAt: "asc" }, take: 100 },
        notes: {
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });

    if (!deal) {
      apiLogger.warn({ msg: "crm/deals:detail-not-found", dealId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Deal not found" }, { status: 404 });
    }

    return NextResponse.json({ deal: redactForCaller(deal, ctx) });
  } catch (err) {
    apiLogger.error({
      msg: "crm/deals:detail-failed",
      dealId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load the deal" }, { status: 500 });
  }
}

/**
 * PATCH /api/crm/deals/[dealId] — field edits only.
 *
 * Stage moves deliberately do NOT go through here: they need the from-stage
 * precondition, so they have their own route (.../stage). Allowing a stage change
 * on a generic PATCH would reintroduce last-write-wins by the back door.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = updateDealSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals/[dealId]:PATCH", organizationId: ctx.organizationId, dealId });
  }

  const result = await updateDeal({
    ...parsed.data,
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx) });
}
