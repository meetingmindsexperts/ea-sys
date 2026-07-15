/**
 * GET /api/crm/sponsor-email/recipients?eventId=… — preview who a prospectus send
 * would reach: the deduped sponsor contacts of the event's non-lost deals.
 *
 * Write-gated (requireCrmWrite blocks MEMBER + rate-limits): a read-only MEMBER may
 * see the board but must not enumerate the sponsor contact list, and this preview is
 * a compose step of a write action.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { resolveSponsorRecipients } from "@/crm/services/sponsor-email-service";

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const eventId = new URL(req.url).searchParams.get("eventId");
  if (!eventId) {
    apiLogger.warn({
      msg: "crm/sponsor-email/recipients:missing-event",
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: "eventId is required", code: "EVENT_REQUIRED" }, { status: 400 });
  }

  try {
    const result = await resolveSponsorRecipients({ organizationId: ctx.organizationId, eventId });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({
      recipients: result.recipients,
      skipped: result.skipped,
      event: { id: result.event.id, name: result.event.name },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/sponsor-email/recipients:failed",
      organizationId: ctx.organizationId,
      eventId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load sponsor recipients" }, { status: 500 });
  }
}
