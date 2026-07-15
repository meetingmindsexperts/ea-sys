/**
 * POST /api/crm/sponsor-email/send — email the sponsorship prospectus to an event's
 * sponsor contacts (a personalized cover email + the attached prospectus).
 *
 * Write-gated + a tighter named bucket on top of the generic CRM write limit: a
 * prospectus blast is a heavy, outward-facing action, so it's 10/hr/org (a leaked
 * key or a fat-fingered loop can't spray the sponsor list). The audience + send live
 * in the service; auth, rate limit, validation and error→HTTP mapping stay here.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { sendSponsorProspectus } from "@/crm/services/sponsor-email-service";

const sendSchema = z.object({
  eventId: z.string().min(1),
  subject: z.string().min(1).max(300),
  message: z.string().min(1).max(50_000),
  contactIds: z.array(z.string().min(1)).max(5_000).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        content: z.string().min(1), // base64
        contentType: z.string().max(150).optional(),
      }),
    )
    .max(5)
    .optional(),
});

export async function POST(req: Request) {
  const { error, ctx } = await requireCrmWrite(req);
  if (error) return error;

  const limit = checkRateLimit({
    key: `crm-sponsor-email:org:${ctx.organizationId}`,
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!limit.allowed) {
    apiLogger.warn({ msg: "crm/sponsor-email/send:rate-limited", organizationId: ctx.organizationId });
    return NextResponse.json(
      {
        error: "Too many sponsor emails sent — try again shortly",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
        limit: 10,
        windowSeconds: 3600,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return zodErrorResponse(parsed, { route: "crm/sponsor-email/send:POST", organizationId: ctx.organizationId });
  }

  const result = await sendSponsorProspectus({
    organizationId: ctx.organizationId,
    eventId: parsed.data.eventId,
    subject: parsed.data.subject,
    message: parsed.data.message,
    attachments: parsed.data.attachments,
    contactIds: parsed.data.contactIds,
    actorUserId: ctx.userId,
    source: ctx.fromApiKey ? "api" : "rest",
  });

  if (!result.ok) return crmErrorResponse(result);

  return NextResponse.json({
    total: result.total,
    successCount: result.successCount,
    failureCount: result.failureCount,
    errors: result.errors,
  });
}
