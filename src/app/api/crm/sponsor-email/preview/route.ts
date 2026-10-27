/**
 * POST /api/crm/sponsor-email/preview — the email one recipient of a deal or
 * sponsor send would receive, rendered by the same code as the send. Nothing is
 * sent or recorded (Oct 27, 2026).
 *
 * Write-gated like the recipients preview: it is a compose step of a write
 * action, and MEMBER must not enumerate the contact list. POST because the body
 * (up to 50,000 characters) does not belong in a URL.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { previewCrmEmail } from "@/crm/services/sponsor-email-service";

const previewSchema = z
  .object({
    eventId: z.string().min(1).optional(),
    dealId: z.string().min(1).optional(),
    contactId: z.string().min(1).optional(),
    sample: z.boolean().optional(),
    // Empty is fine: a preview shows a half-written email as it stands.
    subject: z.string().max(300),
    message: z.string().max(50_000),
  })
  .refine((d) => (d.eventId ? 1 : 0) + (d.dealId ? 1 : 0) === 1, {
    message: "Provide exactly one of eventId or dealId",
    path: ["eventId"],
  });

export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;
  return await runWithTenant(ctx.organizationId, async () => {
    const body = await req.json().catch(() => null);
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/sponsor-email/preview:POST", organizationId: ctx.organizationId });
    }
    const { dealId, eventId, contactId, sample, subject, message } = parsed.data;

    try {
      const result = await previewCrmEmail({
        organizationId: ctx.organizationId,
        target: dealId ? { kind: "deal", id: dealId } : { kind: "event", id: eventId! },
        contactId,
        sample,
        subject,
        message,
        actorUserId: ctx.userId,
      });
      if (!result.ok) return crmErrorResponse(result);
      return NextResponse.json({ subject: result.subject, html: result.html, recipient: result.recipient });
    } catch (err) {
      apiLogger.error({
        msg: "crm/sponsor-email/preview:failed",
        organizationId: ctx.organizationId,
        dealId,
        eventId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Could not build the preview" }, { status: 500 });
    }
  });
}
