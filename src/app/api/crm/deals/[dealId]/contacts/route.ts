import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { addDealContact, removeDealContact } from "@/crm/services/deal-service";

const DEAL_CONTACT_ROLES = ["PRIMARY", "PROCUREMENT", "MARKETING", "TECHNICAL", "INFLUENCER", "OTHER"] as const;

const addSchema = z.object({
  crmContactId: z.string().min(1),
  role: z.enum(DEAL_CONTACT_ROLES).optional(),
});

const removeSchema = z.object({
  crmContactId: z.string().min(1),
});

/**
 * POST /api/crm/deals/[dealId]/contacts — put a person on the deal, with their role.
 *
 * Idempotent: re-adding with a different role UPDATES the role, which is what
 * "actually, Sarah is procurement" should obviously do.
 */
export async function POST(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals/[id]/contacts:POST", organizationId: ctx.organizationId, dealId });
  }

  const result = await addDealContact({
    ...parsed.data,
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true }, { status: 201 });
}

/** DELETE — take them off the deal. Does NOT delete the person. */
export async function DELETE(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = removeSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals/[id]/contacts:DELETE", organizationId: ctx.organizationId, dealId });
  }

  const result = await removeDealContact({
    crmContactId: parsed.data.crmContactId,
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ success: true });
}
