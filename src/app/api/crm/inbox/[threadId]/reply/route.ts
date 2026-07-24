import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse } from "@/lib/api-errors";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/html";
import { requireCrmWrite } from "@/crm/lib/crm-route";
import { canViewCrmInbox } from "@/crm/lib/crm-visibility";
import { crmReplyAddress, recordOutboundEmail } from "@/crm/services/crm-email-thread-service";
import { crmSenderFrom } from "@/crm/services/sponsor-email-service";
import { recordCrmActivity } from "@/crm/lib/crm-activity";

/**
 * POST /api/crm/inbox/[threadId]/reply — reply to the thread's counterparty
 * from inside the CRM.
 *
 * The reply reuses the thread's OWN reply token as its Reply-To, so the
 * conversation keeps threading no matter how many rounds it goes. The sender's
 * email signature is appended (same behavior as the deal Email dialog).
 *
 * Known v1 limitation (deliberate): no In-Reply-To/References headers —
 * sendEmail has no custom-header support yet, and major clients group by
 * subject + participants. The Message-ID chain is stored on the rows for a
 * future upgrade.
 */
const bodySchema = z.object({
  message: z.string().trim().min(1, "A message is required").max(50_000),
});

const PARAGRAPH_STYLE = `style="margin:0 0 8px"`;

/** Plain composer text → simple paragraph HTML (escaped — the text is typed, not authored HTML). */
export function composeReplyHtml(message: string, signatureHtml: string): string {
  const paragraphs = message
    .split(/\n{2,}/)
    .map((p) => `<p ${PARAGRAPH_STYLE}>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
  return signatureHtml ? `${paragraphs}\n${signatureHtml}` : paragraphs;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const [{ error, ctx }, { threadId }] = await Promise.all([requireCrmWrite(req), params]);
  if (error) return error;
  if (!canViewCrmInbox(ctx.role, ctx.fromApiKey)) {
    apiLogger.warn({ msg: "crm/inbox:reply-forbidden", role: ctx.role, userId: ctx.userId });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rl = checkRateLimit({
    key: `crm-inbox-reply:org:${ctx.organizationId}`,
    limit: 60,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, { route: "crm/inbox/reply", organizationId: ctx.organizationId });
  }

  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "crm/inbox/reply", threadId });
    }

    const thread = await db.crmEmailThread.findFirst({
      where: { id: threadId, organizationId: ctx.organizationId },
      select: {
        id: true,
        subject: true,
        replyToken: true,
        counterpartyEmail: true,
        counterpartyName: true,
        deal: { select: { id: true, name: true } },
      },
    });
    if (!thread) {
      apiLogger.warn({ msg: "crm/inbox:reply-thread-not-found", threadId, organizationId: ctx.organizationId });
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }

    const sender = ctx.userId
      ? await db.user.findUnique({
          where: { id: ctx.userId },
          select: { emailSignature: true, firstName: true, lastName: true },
        })
      : null;

    const html = composeReplyHtml(parsed.data.message, sender?.emailSignature ?? "");
    const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`;
    const replyAddress = crmReplyAddress(thread.replyToken);
    // Same CRM sender identity as outbound deal emails (Partnerships), not the
    // platform default. Reply-To stays the tokenized inbox address.
    const from = crmSenderFrom();
    const fromEmail = from?.email ?? process.env.EMAIL_FROM ?? "";
    const fromName = from?.name ?? process.env.EMAIL_FROM_NAME ?? null;

    const res = await sendEmail({
      to: [{ email: thread.counterpartyEmail, name: thread.counterpartyName ?? undefined }],
      ...(from ? { from } : {}),
      ...(replyAddress ? { replyTo: { email: replyAddress, name: fromName ?? undefined } } : {}),
      subject,
      htmlContent: html,
      textContent: parsed.data.message,
      emailType: "crm_email",
      stream: "transactional",
      logContext: {
        organizationId: ctx.organizationId,
        entityType: "OTHER",
        entityId: thread.id,
        templateSlug: "crm-inbox-reply",
        triggeredByUserId: ctx.userId,
      },
    });
    if (!res.success) {
      apiLogger.error({ msg: "crm/inbox:reply-send-failed", threadId, error: res.error });
      return NextResponse.json({ error: "The email could not be sent — try again" }, { status: 502 });
    }

    await recordOutboundEmail({
      organizationId: ctx.organizationId,
      dealId: null, // ignored in append mode
      crmContactId: null,
      counterpartyEmail: thread.counterpartyEmail,
      counterpartyName: thread.counterpartyName,
      subject,
      htmlBody: html,
      textBody: parsed.data.message,
      replyToken: thread.replyToken,
      providerMessageId: res.messageId ?? null,
      sentByUserId: ctx.userId,
      fromEmail,
      fromName,
      threadId: thread.id,
    });

    if (thread.deal) {
      void recordCrmActivity({
        organizationId: ctx.organizationId,
        entityType: "DEAL",
        entityId: thread.deal.id,
        action: "EMAIL_SENT",
        actorId: ctx.userId,
        changes: { subject, via: "inbox-reply" },
      });
    }

    apiLogger.info({ msg: "crm/inbox:reply-sent", threadId, userId: ctx.userId });
    return NextResponse.json({ sent: true });
  } catch (err) {
    apiLogger.error({
      msg: "crm/inbox:reply-failed",
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Could not send the reply" }, { status: 500 });
  }
}
