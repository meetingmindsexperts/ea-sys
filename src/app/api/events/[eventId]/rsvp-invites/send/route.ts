/**
 * Dinner RSVP — email the personalized links (organizer).
 *
 *   POST { target: "all" | "pending", subject?, message? }
 *     → emails each matching invitee their personalized RSVP link
 *       ({{rsvpLink}} = /e/{slug}/rsvp/{token}). "pending" only mails
 *       invitees who haven't responded yet ("remind pending").
 *
 * Uses the same branded email pipeline as the rest of the app
 * (brandingFrom/renderAndWrap/sendEmail + EmailLog). Per-recipient
 * try/catch so one bad address can't kill the batch. denyReviewer,
 * org-scoped, rate-limited (10/hr/event, shared with bulk email spirit).
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import {
  brandingCc,
  brandingFrom,
  renderAndWrap,
  sendEmail,
  type EmailBranding,
} from "@/lib/email";

type RouteParams = { params: Promise<{ eventId: string }> };

const sendSchema = z.object({
  target: z.enum(["all", "pending"]),
  subject: z.string().trim().max(200).optional(),
  message: z.string().max(10000).optional(),
});

function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}

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
      key: `rsvp-send:${eventId}`,
      limit: 10,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "rsvp-send:rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId }, "rsvp-send:validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: {
        id: true,
        name: true,
        slug: true,
        emailFromAddress: true,
        emailFromName: true,
        emailHeaderImage: true,
        emailFooterImage: true,
        emailFooterHtml: true,
        emailCcAddresses: true,
        organization: { select: { name: true } },
      },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const invites = await db.rsvpInvite.findMany({
      where: {
        eventId,
        ...(parsed.data.target === "pending" ? { status: "PENDING" } : {}),
      },
      select: { id: true, inviteeName: true, inviteeEmail: true, token: true },
    });
    if (invites.length === 0) {
      return NextResponse.json({ sent: 0, failed: 0, message: "No matching invitees." });
    }

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
    const branding: EmailBranding = {
      emailHeaderImage: event.emailHeaderImage,
      emailFooterImage: event.emailFooterImage,
      emailFooterHtml: event.emailFooterHtml,
      emailFromAddress: event.emailFromAddress,
      emailFromName: event.emailFromName,
      emailCcAddresses: event.emailCcAddresses,
      eventName: event.name,
    };
    const from = brandingFrom(branding);

    const subject = parsed.data.subject?.trim() || `You're invited — {{eventName}} dinners`;
    const messageHtml = parsed.data.message?.trim() || "";

    // The body: optional organizer message + a big RSVP button. Both the
    // message and the button carry raw HTML, so they're in rawHtmlKeys.
    const htmlContent = `
      <p>Dear {{firstName}},</p>
      ${messageHtml ? `<div>{{message}}</div>` : `<p>You're invited to the dinners for <strong>{{eventName}}</strong>. Please let us know which you'll attend.</p>`}
      <p style="text-align:center;margin:28px 0;">
        <a href="{{rsvpLink}}" style="background:#00aade;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">RSVP now</a>
      </p>
      <p style="font-size:13px;color:#667;">If the button doesn't work, copy this link into your browser:<br>{{rsvpLink}}</p>
    `;
    const textContent =
      "Dear {{firstName}},\n\nYou're invited to the dinners for {{eventName}}. RSVP here:\n{{rsvpLink}}\n";

    let sent = 0;
    let failed = 0;
    for (const inv of invites) {
      const rsvpLink = `${appUrl}/e/${event.slug}/rsvp/${inv.token}`;
      try {
        const rendered = renderAndWrap(
          { subject, htmlContent, textContent },
          {
            firstName: firstNameOf(inv.inviteeName),
            eventName: event.name,
            rsvpLink,
            message: messageHtml,
          },
          branding,
          new Set(["message", "rsvpLink"]),
        );
        await sendEmail({
          to: [{ email: inv.inviteeEmail, name: inv.inviteeName }],
          cc: brandingCc(branding, [{ email: inv.inviteeEmail }]),
          from,
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
          logContext: {
            organizationId: session.user.organizationId,
            eventId,
            entityType: "OTHER",
            entityId: inv.id,
            templateSlug: "dinner-rsvp-invitation",
            triggeredByUserId: session.user.id,
          },
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        apiLogger.error({ err, eventId, inviteId: inv.id }, "rsvp-send:recipient-failed");
      }
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SEND",
          entityType: "RSVP_INVITE",
          entityId: `send:${parsed.data.target}`,
          changes: { target: parsed.data.target, sent, failed },
        },
      })
      .catch((err) => apiLogger.error({ err }, "rsvp-send:audit-failed"));

    apiLogger.info({ eventId, target: parsed.data.target, sent, failed }, "rsvp-send:done");
    return NextResponse.json({ sent, failed });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-send:failed");
    return NextResponse.json({ error: "Failed to send invitations" }, { status: 500 });
  }
}
