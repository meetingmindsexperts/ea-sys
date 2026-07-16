import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmRead, requireCrmWrite, requireCrmDelete, denyCrmDelete, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { updateDeal, setDealArchived } from "@/crm/services/deal-service";

const updateDealSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  companyId: z.string().min(1).nullable().optional(),
  // Re-pointable, but not clearable — a deal must stay tied to an event (no null).
  eventId: z.string().min(1).optional(),
  ownerId: z.string().min(1).nullable().optional(),
  dealValue: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  currency: z.string().length(3).optional(),
  expectedClose: z.coerce.date().nullable().optional(),
  /** Restore a soft-deleted deal (archive → active). Delete-gated separately below. */
  archived: z.boolean().optional(),
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
          // An archived rep must not linger on deal pages (CRM review L9) — the
          // company detail and the email recipient resolver already exclude them.
          where: { crmContact: { archivedAt: null } },
          include: {
            crmContact: { select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, phone: true } },
          },
        },
        event: { select: { id: true, name: true, slug: true } },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        stage: { select: { id: true, name: true, isTerminal: true } },
        tasks: { where: { archivedAt: null }, orderBy: { dueAt: "asc" }, take: 100 },
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

  const { archived, ...fields } = parsed.data;

  // Archive / restore is a separate, more-privileged operation than a field edit
  // (ORGANIZER may edit but not archive), so it carries its own gate.
  if (archived !== undefined) {
    const denied = denyCrmDelete(ctx);
    if (denied) return denied;
    const result = await setDealArchived({
      dealId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: ctx.fromApiKey ? "api" : "rest",
      archived,
    });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({ deal: redactForCaller(result.deal, ctx) });
  }

  const result = await updateDeal({
    ...fields,
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    requestIp: getClientIp(req) ?? undefined,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx) });
}

/** DELETE /api/crm/deals/[dealId] — archive (soft delete). Admin + CRM_USER only. */
export async function DELETE(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmDelete(req), params]);
  if (error) return error;

  const result = await setDealArchived({
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    archived: true,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx), archived: true });
}
