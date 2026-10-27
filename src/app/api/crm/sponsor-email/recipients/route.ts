/**
 * GET /api/crm/sponsor-email/recipients?eventId=… | ?dealId=… | ?threadId=… —
 * preview who a send would reach: the deduped contacts of an event's non-lost
 * deals, one deal's contacts, or the one person an inbox reply goes to.
 *
 * Write-gated (requireCrmWrite blocks MEMBER + rate-limits): a read-only MEMBER may
 * see the board but must not enumerate the contact list, and this preview is a
 * compose step of a write action.
 */
import { NextResponse } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import {
  resolveSponsorRecipients,
  resolveDealRecipients,
  resolveThreadRecipients,
} from "@/crm/services/sponsor-email-service";

export async function GET(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
  return await runWithTenant(ctx.organizationId, async () => {

  const params = new URL(req.url).searchParams;
  const eventId = params.get("eventId");
  const dealId = params.get("dealId");
  const threadId = params.get("threadId");

  if (!eventId && !dealId && !threadId) {
    apiLogger.warn({ msg: "crm/sponsor-email/recipients:missing-target", organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: "eventId, dealId or threadId is required", code: "TARGET_REQUIRED" },
      { status: 400 },
    );
  }

  try {
    if (threadId) {
      const result = await resolveThreadRecipients({ organizationId: ctx.organizationId, threadId });
      if (!result.ok) return crmErrorResponse(result);
      return NextResponse.json({
        recipients: result.recipients,
        skipped: result.skipped,
        target: { kind: "thread", id: result.target.id, name: result.target.name },
      });
    }
    if (dealId) {
      const result = await resolveDealRecipients({ organizationId: ctx.organizationId, dealId });
      if (!result.ok) return crmErrorResponse(result);
      return NextResponse.json({
        recipients: result.recipients,
        skipped: result.skipped,
        target: { kind: "deal", id: result.target.id, name: result.target.name },
      });
    }

    const result = await resolveSponsorRecipients({ organizationId: ctx.organizationId, eventId: eventId! });
    if (!result.ok) return crmErrorResponse(result);
    return NextResponse.json({
      recipients: result.recipients,
      skipped: result.skipped,
      target: { kind: "event", id: result.event.id, name: result.event.name },
    });
  } catch (err) {
    apiLogger.error({
      msg: "crm/sponsor-email/recipients:failed",
      organizationId: ctx.organizationId,
      eventId,
      dealId,
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not load recipients" }, { status: 500 });
  }
  });
}
