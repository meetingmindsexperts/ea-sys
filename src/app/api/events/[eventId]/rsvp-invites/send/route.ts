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
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import {
  brandingCc,
  brandingFrom,
  getEventTemplate,
  renderAndWrap,
  renderMessageValue,
  sendEmail,
} from "@/lib/email";

type RouteParams = { params: Promise<{ eventId: string }> };

// Single code path for single + bulk sends: `inviteId` sends to exactly one
// invitee; otherwise `target` (all / pending) selects the batch. Same template,
// same per-recipient render (each gets their own token link).
const sendSchema = z
  .object({
    target: z.enum(["all", "pending"]).optional(),
    inviteId: z.string().max(100).optional(),
    subject: z.string().trim().max(200).optional(),
    message: z.string().max(10000).optional(),
  })
  .refine((v) => v.inviteId || v.target, {
    message: "Provide either an inviteId (single) or a target (all/pending).",
  });

function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName.trim();
}
function lastNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
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
      // buildEventAccessWhere (R2 L9) — parity with the roster GET.
      where: buildEventAccessWhere(session.user, eventId),
      select: {
        id: true,
        name: true,
        slug: true,
        organization: { select: { name: true } },
      },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "rsvp-send:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const [invites, tpl, sender, dinnerCount] = await Promise.all([
      db.rsvpInvite.findMany({
        // inviteId → exactly that invitee (event-scoped); else the target batch.
        where: parsed.data.inviteId
          ? { id: parsed.data.inviteId, eventId }
          : { eventId, ...(parsed.data.target === "pending" ? { status: "PENDING" } : {}) },
        select: { id: true, inviteeName: true, inviteeEmail: true, token: true },
      }),
      // Loads the per-event override if the organizer customised it, else the
      // system default — both carry the resolved event branding.
      getEventTemplate(eventId, "dinner-rsvp-invitation"),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, emailSignature: true },
      }),
      // Drives {{dinnerWord}} — singular when the event has just one dinner.
      db.rsvpDinner.count({ where: { eventId, isActive: true } }),
    ]);
    if (invites.length === 0) {
      apiLogger.info(
        { eventId, target: parsed.data.target, inviteId: parsed.data.inviteId },
        "rsvp-send:no-recipients",
      );
      return NextResponse.json({ sent: 0, failed: 0, message: "No matching invitees." });
    }
    if (!tpl) {
      apiLogger.error({ eventId }, "rsvp-send:template-missing");
      return NextResponse.json({ error: "Dinner RSVP email template not found" }, { status: 500 });
    }
    // R2 L15: an invitation whose link lands on "No dinners have been set up
    // yet" is an embarrassing send — refuse until at least one active dinner
    // exists.
    if (dinnerCount === 0) {
      apiLogger.warn({ eventId, userId: session.user.id }, "rsvp-send:no-dinners");
      return NextResponse.json(
        { error: "Set up at least one dinner before emailing invitations.", code: "NO_DINNERS" },
        { status: 400 },
      );
    }

    // R2 M6: batch retry-safety. This route sends inline (no job queue), so a
    // mid-loop timeout/deploy + the operator's natural retry used to re-mail
    // everyone already mailed. The EmailLog rows this route already writes are
    // the resume state: on BATCH sends, skip invitees successfully mailed in
    // the last 10 minutes. A single-invitee send (per-row "Send") is an
    // explicit, intentional resend and is never skipped.
    let skippedRecentlyInvited = 0;
    let toSend = invites;
    if (!parsed.data.inviteId) {
      const recentLogs = await db.emailLog.findMany({
        where: {
          eventId,
          templateSlug: "dinner-rsvp-invitation",
          status: "SENT",
          entityId: { in: invites.map((i) => i.id) },
          createdAt: { gt: new Date(Date.now() - 10 * 60_000) },
        },
        select: { entityId: true },
      });
      const recentlySent = new Set(recentLogs.map((l) => l.entityId));
      toSend = invites.filter((i) => !recentlySent.has(i.id));
      skippedRecentlyInvited = invites.length - toSend.length;
      if (skippedRecentlyInvited > 0) {
        apiLogger.info(
          { eventId, skippedRecentlyInvited, target: parsed.data.target },
          "rsvp-send:skipped-recently-invited",
        );
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
    const dinnerWord = dinnerCount === 1 ? "dinner" : "dinners";
    const rawHtmlKeys = new Set(["personalMessage", "rsvpLink", "organizerSignature"]);

    let sent = 0;
    let failed = 0;
    for (const inv of toSend) {
      const rsvpLink = `${appUrl}/e/${event.slug}/rsvp/${inv.token}`;
      try {
        const vars: Record<string, string> = {
          // Per-recipient — every email in a bulk send gets the invitee's own
          // name, email and token link (never a shared link).
          firstName: firstNameOf(inv.inviteeName),
          lastName: lastNameOf(inv.inviteeName),
          fullName: inv.inviteeName,
          email: inv.inviteeEmail,
          eventName: event.name,
          dinnerWord,
          rsvpLink,
          personalMessage,
          organizerName,
          organizerSignature,
        };
        // R2 M8: tokens the organizer typed INTO the message box
        // ({{firstName}}, {{organizerSignature}}, …) resolve per recipient
        // instead of landing as literal text — the July-16 wiring the other
        // three senders got. {{personalMessage}}'s historical raw-literal
        // contract is kept (isHtml: true).
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
          entityId: parsed.data.inviteId ? `send:${parsed.data.inviteId}` : `send:${parsed.data.target}`,
          changes: { target: parsed.data.target, inviteId: parsed.data.inviteId, sent, failed, skippedRecentlyInvited },
        },
      })
      .catch((err) => apiLogger.error({ err }, "rsvp-send:audit-failed"));

    apiLogger.info(
      { eventId, target: parsed.data.target, inviteId: parsed.data.inviteId, sent, failed, skippedRecentlyInvited },
      "rsvp-send:done",
    );
    return NextResponse.json({ sent, failed, skippedRecentlyInvited });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-send:failed");
    return NextResponse.json({ error: "Failed to send invitations" }, { status: 500 });
  }
}
