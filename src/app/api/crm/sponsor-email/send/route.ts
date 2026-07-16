/**
 * POST /api/crm/sponsor-email/send — email an event's sponsors (eventId) OR one
 * deal's contacts (dealId), with a personalized cover email + attachments.
 *
 * Write-gated + a tighter named bucket on top of the generic CRM write limit: an
 * outward-facing blast is 10/hr/org (a leaked key or a fat-fingered loop can't spray
 * the contact list). The audience + send live in the service; auth, rate limit,
 * validation and error→HTTP mapping stay here.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { sendSponsorProspectus, sendDealEmail } from "@/crm/services/sponsor-email-service";

/** Double-submit window: an identical blast inside this window is a repeat, not a new send. */
const DEDUP_WINDOW_MS = 2 * 60 * 1000;

const sendSchema = z
  .object({
    eventId: z.string().min(1).optional(),
    dealId: z.string().min(1).optional(),
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
  })
  // Exactly one target — an ambiguous or targetless send is a client bug, not a
  // "send to everything" (the narrow-never-widen posture).
  .refine((d) => (d.eventId ? 1 : 0) + (d.dealId ? 1 : 0) === 1, {
    message: "Provide exactly one of eventId or dealId",
    path: ["eventId"],
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
        error: "Too many emails sent — try again shortly",
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

  // Double-submit idempotency (CRM review M3): the send is synchronous and slow
  // (base64 attachments, batches of 25), so a double-click / browser retry /
  // impatient second press used to re-email the WHOLE audience — the 10/hr
  // bucket happily admits both halves of a double-click. A content+audience hash
  // with a 2-minute window makes the identical request a 409, same posture as
  // the event bulk-email dedup (comms review H2). Best-effort (in-memory, like
  // every rate bucket) — the backstop, not the audit trail.
  const dedupHash = createHash("sha256")
    .update(
      JSON.stringify({
        target: parsed.data.dealId ? `deal:${parsed.data.dealId}` : `event:${parsed.data.eventId}`,
        subject: parsed.data.subject,
        message: parsed.data.message,
        contactIds: [...(parsed.data.contactIds ?? [])].sort(),
      }),
    )
    .digest("hex");
  const dedup = checkRateLimit({
    key: `crm-sponsor-email-dedup:${ctx.organizationId}:${dedupHash}`,
    limit: 1,
    windowMs: DEDUP_WINDOW_MS,
  });
  if (!dedup.allowed) {
    apiLogger.warn({
      msg: "crm/sponsor-email/send:duplicate-suppressed",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      dedupHash: dedupHash.slice(0, 12),
    });
    return NextResponse.json(
      {
        error: "This exact email was just sent — it is not being sent twice. Wait a couple of minutes if you really mean to repeat it.",
        code: "DUPLICATE_SEND",
        retryAfterSeconds: dedup.retryAfterSeconds,
      },
      { status: 409 },
    );
  }

  const common = {
    organizationId: ctx.organizationId,
    subject: parsed.data.subject,
    message: parsed.data.message,
    attachments: parsed.data.attachments,
    contactIds: parsed.data.contactIds,
    actorUserId: ctx.userId,
    source: (ctx.fromApiKey ? "api" : "rest") as "api" | "rest",
  };

  const result = parsed.data.dealId
    ? await sendDealEmail({ ...common, dealId: parsed.data.dealId })
    : await sendSponsorProspectus({ ...common, eventId: parsed.data.eventId! });

  if (!result.ok) return crmErrorResponse(result);

  return NextResponse.json({
    total: result.total,
    successCount: result.successCount,
    failureCount: result.failureCount,
    errors: result.errors,
  });
}
