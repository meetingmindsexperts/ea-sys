import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { closeDeal } from "@/crm/services/deal-service";

const closeSchema = z.object({
  outcome: z.enum(["WON", "LOST"]),
  lostReason: z.string().max(500).optional().nullable(),
});

/**
 * POST /api/crm/deals/[dealId]/close
 *
 * Guarded against double-close in the service (conditional claim on status=OPEN):
 * re-closing an already-won deal would re-stamp wonAt and quietly corrupt any
 * "deals won in July" report.
 */
export async function POST(req: Request, { params }: { params: Promise<{ dealId: string }> }) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/deals/[dealId]/close:POST", organizationId: ctx.organizationId, dealId });
  }

  const result = await closeDeal({
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    outcome: parsed.data.outcome,
    lostReason: parsed.data.lostReason ?? null,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx) });
}
