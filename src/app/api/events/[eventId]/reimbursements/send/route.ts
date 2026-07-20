/**
 * Speaker reimbursements — email the personalized form links (organizer).
 *
 *   POST { reimbursementId? , target?: "all" | "pending", subject?, message? }
 *     → emails each matching speaker their personalized reimbursement link
 *       ({{reimbursementLink}} = /e/{slug}/reimbursement/{token}).
 *       "pending" = not yet submitted ("remind pending"). `reimbursementId`
 *       sends to exactly one speaker (explicit resend — never skipped).
 *
 * Same branded pipeline as every sender (brandingFrom / renderAndWrap /
 * sendEmail + EmailLog), per-recipient try/catch, batch retry-safety via
 * recent EmailLog rows. Staff-only via denyReviewer; org-scoped; 10/hr/event.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { formatPersonName } from "@/lib/utils";
import {
  brandingCc,
  brandingFrom,
  getEventTemplate,
  renderAndWrap,
  renderMessageValue,
  sendEmail,
} from "@/lib/email";

type RouteParams = { params: Promise<{ eventId: string }> };

const TEMPLATE_SLUG = "speaker-reimbursement-invitation";

const sendSchema = z
  .object({
    target: z.enum(["all", "pending"]).optional(),
    reimbursementId: z.string().max(100).optional(),
    subject: z.string().trim().max(200).optional(),
    message: z.string().max(10000).optional(),
  })
  .refine((v) => v.reimbursementId || v.target, {
    message: "Provide either a reimbursementId (single) or a target (all/pending).",
  });

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `reimbursements-send:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursements-send:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId }, "reimbursements-send:validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, name: true, slug: true, organization: { select: { name: true } } },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursements-send:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const [rows, tpl, sender] = await Promise.all([
      db.speakerReimbursement.findMany({
        where: parsed.data.reimbursementId
          ? { id: parsed.data.reimbursementId, eventId }
          : { eventId, ...(parsed.data.target === "pending" ? { status: "PENDING" } : {}) },
        select: {
          id: true,
          token: true,
          speakerId: true,
          speaker: { select: { title: true, firstName: true, lastName: true, email: true } },
        },
      }),
      getEventTemplate(eventId, TEMPLATE_SLUG),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, emailSignature: true },
      }),
    ]);
    if (rows.length === 0) {
      apiLogger.info(
        { eventId, target: parsed.data.target, reimbursementId: parsed.data.reimbursementId },
        "reimbursements-send:no-recipients",
      );
      return NextResponse.json({ sent: 0, failed: 0, message: "No matching speakers." });
    }
    if (!tpl) {
      apiLogger.error({ eventId }, "reimbursements-send:template-missing");
      return NextResponse.json({ error: "Reimbursement email template not found" }, { status: 500 });
    }

    // Batch retry-safety (the RSVP-send M6 pattern): this route sends inline,
    // so a mid-loop timeout + the operator's natural retry must not re-mail
    // everyone. The EmailLog rows we already write are the resume state —
    // batch sends skip rows successfully mailed in the last 10 minutes; a
    // single-row send is an explicit resend and is never skipped.
    let skippedRecentlySent = 0;
    let toSend = rows;
    if (!parsed.data.reimbursementId) {
      const recentLogs = await db.emailLog.findMany({
        where: {
          eventId,
          templateSlug: TEMPLATE_SLUG,
          status: "SENT",
          entityId: { in: rows.map((r) => r.speakerId) },
          createdAt: { gt: new Date(Date.now() - 10 * 60_000) },
        },
        select: { entityId: true },
      });
      const recentlySent = new Set(recentLogs.map((l) => l.entityId));
      toSend = rows.filter((r) => !recentlySent.has(r.speakerId));
      skippedRecentlySent = rows.length - toSend.length;
      if (skippedRecentlySent > 0) {
        apiLogger.info({ eventId, skippedRecentlySent }, "reimbursements-send:skipped-recently-sent");
      }
    }

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const branding = tpl.branding;
    const from = brandingFrom(branding);
    const subject = parsed.data.subject?.trim() || tpl.subject;
    const personalMessage = parsed.data.message?.trim() || "";
    const organizerName =
      event.organization?.name ||
      `${sender?.firstName ?? ""} ${sender?.lastName ?? ""}`.trim() ||
      "Event Organizer";
    const organizerSignature = sender?.emailSignature || "";
    const rawHtmlKeys = new Set(["personalMessage", "reimbursementLink", "organizerSignature"]);

    let sent = 0;
    let failed = 0;
    for (const row of toSend) {
      const reimbursementLink = `${appUrl}/e/${event.slug}/reimbursement/${row.token}`;
      try {
        const vars: Record<string, string> = {
          firstName: row.speaker.firstName,
          lastName: row.speaker.lastName,
          speakerName: formatPersonName(row.speaker.title, row.speaker.firstName, row.speaker.lastName),
          email: row.speaker.email,
          eventName: event.name,
          reimbursementLink,
          personalMessage,
          organizerName,
          organizerSignature,
        };
        // Tokens typed INTO the message box resolve per recipient (the
        // July-16 renderMessageValue wiring); {{personalMessage}} keeps its
        // raw-literal contract.
        vars.personalMessage = renderMessageValue(personalMessage, vars, {
          isHtml: true,
          rawHtmlKeys,
        });
        const rendered = renderAndWrap(
          { subject, htmlContent: tpl.htmlContent, textContent: tpl.textContent },
          vars,
          branding,
          rawHtmlKeys,
        );
        await sendEmail({
          to: [{ email: row.speaker.email, name: `${row.speaker.firstName} ${row.speaker.lastName}` }],
          cc: brandingCc(branding, [{ email: row.speaker.email }]),
          from,
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
          logContext: {
            organizationId: session.user.organizationId,
            eventId,
            // Logged against the SPEAKER so the send shows on the speaker's
            // Email History / Activity timeline (and retry-safety keys on it).
            entityType: "SPEAKER",
            entityId: row.speakerId,
            templateSlug: TEMPLATE_SLUG,
            triggeredByUserId: session.user.id,
          },
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        apiLogger.error({ err, eventId, reimbursementId: row.id }, "reimbursements-send:recipient-failed");
      }
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SEND",
          entityType: "SPEAKER_REIMBURSEMENT",
          entityId: parsed.data.reimbursementId
            ? `send:${parsed.data.reimbursementId}`
            : `send:${parsed.data.target}`,
          changes: {
            target: parsed.data.target,
            reimbursementId: parsed.data.reimbursementId,
            sent,
            failed,
            skippedRecentlySent,
          },
        },
      })
      .catch((err) => apiLogger.error({ err }, "reimbursements-send:audit-failed"));

    apiLogger.info(
      { eventId, target: parsed.data.target, reimbursementId: parsed.data.reimbursementId, sent, failed, skippedRecentlySent },
      "reimbursements-send:done",
    );
    return NextResponse.json({ sent, failed, skippedRecentlySent });
  } catch (err) {
    apiLogger.error({ err }, "reimbursements-send:failed");
    return NextResponse.json({ error: "Failed to send reimbursement links" }, { status: 500 });
  }
}
