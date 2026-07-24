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
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { zodErrorResponse } from "@/lib/api-errors";
import { requireCrmWrite, crmErrorResponse } from "@/crm/lib/crm-route";
import { sendSponsorProspectus, sendDealEmail } from "@/crm/services/sponsor-email-service";
import { claimCrmEmailSend, CRM_EMAIL_DEDUP_WINDOW_MS } from "@/crm/lib/crm-email-dedup";

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
    /**
     * Stored deal documents (the prospectus etc.) to attach — resolved server-
     * side from CrmDealDocument, so nothing is re-uploaded per send. Deal
     * sends only. The combined stored + ad-hoc list rides the service's
     * 5-file/10MB caps.
     */
    documentIds: z.array(z.string().min(1)).max(5).optional(),
    /** Extra CC / BCC recipients (manual). Each is added to every send. */
    cc: z.array(z.string().email()).max(50).optional(),
    bcc: z.array(z.string().email()).max(50).optional(),
    /**
     * Auto-BCC the sending user's own address so a copy lands in their Outlook.
     * Defaults ON (undefined → true) — the "see it in my mailbox" behavior.
     */
    copyToSender: z.boolean().optional(),
  })
  // Exactly one target — an ambiguous or targetless send is a client bug, not a
  // "send to everything" (the narrow-never-widen posture).
  .refine((d) => (d.eventId ? 1 : 0) + (d.dealId ? 1 : 0) === 1, {
    message: "Provide exactly one of eventId or dealId",
    path: ["eventId"],
  })
  .refine((d) => !d.documentIds?.length || !!d.dealId, {
    message: "documentIds are only valid on a deal send",
    path: ["documentIds"],
  });

const DEAL_DOCS_ROOT = path.resolve(process.cwd(), "public", "uploads", "crm-deal-docs");

/**
 * Resolve stored deal-document ids into base64 attachments.
 *
 * Every id must resolve — bound to THE deal AND the org (an invented or
 * foreign id is refused, never silently dropped: an email that claims to
 * carry the prospectus but quietly doesn't is the dishonesty bug class).
 * File reads are re-rooted under the deal-docs directory (traversal guard).
 */
async function loadStoredAttachments(
  organizationId: string,
  dealId: string,
  documentIds: string[],
): Promise<
  | { ok: true; attachments: Array<{ name: string; content: string; contentType: string }> }
  | { ok: false; code: string; message: string }
> {
  const docs = await db.crmDealDocument.findMany({
    where: { id: { in: documentIds }, dealId, organizationId },
    select: { id: true, url: true, filename: true, mimeType: true },
  });
  if (docs.length !== documentIds.length) {
    const found = new Set(docs.map((d) => d.id));
    apiLogger.warn({
      msg: "crm/sponsor-email/send:unknown-document-ids",
      dealId,
      organizationId,
      missing: documentIds.filter((id) => !found.has(id)),
    });
    return { ok: false, code: "DOCUMENT_NOT_FOUND", message: "One of the selected documents no longer exists on this deal" };
  }

  const attachments: Array<{ name: string; content: string; contentType: string }> = [];
  for (const doc of docs) {
    const abs = path.resolve(process.cwd(), "public", doc.url.replace(/^\//, ""));
    if (!doc.url.startsWith("/uploads/crm-deal-docs/") || !abs.startsWith(DEAL_DOCS_ROOT + path.sep)) {
      apiLogger.error({ msg: "crm/sponsor-email/send:document-path-rejected", documentId: doc.id, url: doc.url });
      return { ok: false, code: "DOCUMENT_FILE_MISSING", message: "A selected document could not be read" };
    }
    try {
      const buf = await fs.readFile(abs);
      attachments.push({ name: doc.filename, content: buf.toString("base64"), contentType: doc.mimeType });
    } catch (err) {
      // Honest failure: refuse the send rather than deliver without the file.
      apiLogger.error({
        msg: "crm/sponsor-email/send:document-read-failed",
        documentId: doc.id,
        url: doc.url,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        code: "DOCUMENT_FILE_MISSING",
        message: `The stored file for "${doc.filename}" is missing — re-upload it on the deal, then send again`,
      };
    }
  }
  return { ok: true, attachments };
}

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

  // Double-submit idempotency (CRM review M2): the send is synchronous and slow
  // (base64 attachments, batches of 25), so a double-click / browser retry /
  // impatient second press used to re-email the WHOLE audience — the 10/hr
  // bucket happily admits both halves of a double-click. A content+audience hash
  // is claimed in a DB row so an identical request is a 409. DB-backed (not the
  // in-memory rate limiter) so it holds across containers and survives a
  // blue-green swap, with a longer (10-min) window than the old 2-min bucket.
  const dedupHash = createHash("sha256")
    .update(
      JSON.stringify({
        target: parsed.data.dealId ? `deal:${parsed.data.dealId}` : `event:${parsed.data.eventId}`,
        subject: parsed.data.subject,
        message: parsed.data.message,
        contactIds: [...(parsed.data.contactIds ?? [])].sort(),
        documentIds: [...(parsed.data.documentIds ?? [])].sort(),
      }),
    )
    .digest("hex");
  const claimed = await claimCrmEmailSend(ctx.organizationId, dedupHash);
  if (!claimed) {
    apiLogger.warn({
      msg: "crm/sponsor-email/send:duplicate-suppressed",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      dedupHash: dedupHash.slice(0, 12),
    });
    return NextResponse.json(
      {
        error: "This exact email was just sent — it is not being sent twice. Wait a few minutes if you really mean to repeat it.",
        code: "DUPLICATE_SEND",
        retryAfterSeconds: Math.ceil(CRM_EMAIL_DEDUP_WINDOW_MS / 1000),
      },
      { status: 409 },
    );
  }

  // Stored deal documents ride ahead of the ad-hoc uploads; the service's
  // combined 5-file/10MB caps apply to the merged list.
  let attachments = parsed.data.attachments ?? [];
  if (parsed.data.dealId && parsed.data.documentIds?.length) {
    const stored = await loadStoredAttachments(ctx.organizationId, parsed.data.dealId, parsed.data.documentIds);
    if (!stored.ok) return crmErrorResponse(stored);
    attachments = [...stored.attachments, ...attachments];
  }

  const common = {
    organizationId: ctx.organizationId,
    subject: parsed.data.subject,
    message: parsed.data.message,
    attachments: attachments.length > 0 ? attachments : undefined,
    contactIds: parsed.data.contactIds,
    cc: parsed.data.cc,
    bcc: parsed.data.bcc,
    // Default ON — an API caller must explicitly send false to opt out.
    copyToSender: parsed.data.copyToSender ?? true,
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
