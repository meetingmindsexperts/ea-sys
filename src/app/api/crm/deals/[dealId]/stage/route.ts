import { NextResponse } from "next/server";
import { z } from "zod";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, redactForCaller, crmErrorResponse } from "@/crm/lib/crm-route";
import { moveDealStage } from "@/crm/services/deal-service";

/**
 * `fromStageId` is REQUIRED, and that is the whole point of this route.
 *
 * It is the stage the person saw the card in when they picked it up. The service
 * makes it a precondition of the write, so if a colleague moved the same card in
 * the meantime this request loses the race and gets a 409 STAGE_CHANGED instead
 * of silently overwriting their decision. The client then rolls its optimistic
 * move back and refetches.
 *
 * A move endpoint that took only `toStageId` would be last-write-wins — which on
 * a shared kanban board means a card lands in a column nobody chose.
 */
const moveSchema = z.object({
  fromStageId: z.string().min(1),
  toStageId: z.string().min(1),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ dealId: string }> },
) {
  const [{ error, ctx }, { dealId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = moveSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, {
      route: "crm/deals/[dealId]/stage:PATCH",
      organizationId: ctx.organizationId,
      dealId,
    });
  }

  const result = await moveDealStage({
    dealId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
    fromStageId: parsed.data.fromStageId,
    toStageId: parsed.data.toStageId,
  });

  if (!result.ok) return crmErrorResponse(result);
  return NextResponse.json({ deal: redactForCaller(result.deal, ctx) });
}
