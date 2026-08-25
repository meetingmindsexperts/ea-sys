/**
 * RSVP — email the personalized links for ONE campaign (organizer).
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
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse, apiErrorResponse } from "@/lib/api-errors";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";
import {
  brandingCc,
  brandingFrom,
  getEventTemplate,
  renderAndWrap,
  renderMessageValue,
  sendEmail,
} from "@/lib/email";

type RouteParams = { params: Promise<{ eventId: string; campaignId: string }> };

/**
 * The template slug is a KEY, not a label. 17 events already hold a
 * materialised `dinner-rsvp-invitation` EmailTemplate row (the templates list
 * GET auto-seeds system defaults as editable rows), so renaming it would
 * orphan every one of them and silently fall back to the default for anyone
 * who had actually edited theirs. Same rule as the Aug 11 presenter round.
 */
const RSVP_INVITATION_SLUG = "dinner-rsvp-invitation";

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
  const route = "POST /events/[eventId]/rsvp-campaigns/[campaignId]/invites/send";
  try {
    const [session, { eventId, campaignId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]/invites/send:POST" });
    if (denied) return denied;

    const limit = checkRateLimit({ key: `rsvp-send:${eventId}`, limit: 10, windowMs: 3600_000 });
    if (!limit.allowed) {
      return rateLimited(limit, { route, eventId, campaignId, userId: session.user.id });
    }

    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, campaignId, userId: session.user.id });
    }

    const accessible = await loadRsvpEvent(session.user, eventId);
    if (!accessible) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        organization: { select: { name: true } },
      },
    });
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    // Resource-org lane: the swept RsvpInvite/RsvpItem reads below AND the
    // EmailLog resume-read (swept as of Domain #18, Aug 3 2026 — under
    // platform RLS a lane-less dedup read would fail-close to [] and re-mail
    // the whole batch) all run here.
    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }

      const [invites, tpl, sender, itemCount] = await Promise.all([
        db.rsvpInvite.findMany({
          // inviteId → exactly that invitee (campaign-scoped); else the batch.
          where: parsed.data.inviteId
            ? { id: parsed.data.inviteId, campaignId }
            : { campaignId, ...(parsed.data.target === "pending" ? { status: "PENDING" } : {}) },
          select: { id: true, inviteeName: true, inviteeEmail: true, token: true },
        }),
        // Loads the per-event override if the organizer customised it, else the
        // system default — both carry the resolved event branding.
        getEventTemplate(eventId, RSVP_INVITATION_SLUG),
        db.user.findUnique({
          where: { id: session.user.id },
          select: { firstName: true, lastName: true, emailSignature: true },
        }),
        // Drives {{dinnerWord}} — singular when the campaign has just one item.
        db.rsvpItem.count({ where: { campaignId, isActive: true } }),
      ]);
      if (invites.length === 0) {
        apiLogger.info(
          { eventId, campaignId, target: parsed.data.target, inviteId: parsed.data.inviteId },
          "rsvp-send:no-recipients",
        );
        return NextResponse.json({ sent: 0, failed: 0, message: "No matching invitees." });
      }
      if (!tpl) {
        apiLogger.error({ eventId, campaignId }, "rsvp-send:template-missing");
        return NextResponse.json({ error: "RSVP email template not found" }, { status: 500 });
      }
      // R2 L15: an invitation whose link lands on "Nothing has been set up yet"
      // is an embarrassing send — refuse until at least one active item exists.
      if (itemCount === 0) {
        return apiErrorResponse(
          400,
          "Add at least one item to this RSVP before emailing invitations.",
          { route, eventId, campaignId, userId: session.user.id },
          { code: "NO_ITEMS" },
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
            templateSlug: RSVP_INVITATION_SLUG,
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
            { eventId, campaignId, skippedRecentlyInvited, target: parsed.data.target },
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
      // These are NOT aliases — they render different words, and an earlier
      // comment here claimed otherwise, which would have quietly rewritten an
      // organizer's copy from "dinner" to "session" the moment they followed
      // the docs and swapped the token.
      //
      // `dinnerWord` is kept because 17 events already hold a materialised
      // `dinner-rsvp-invitation` row referencing it — a slug and a variable
      // name are both KEYS, not labels. It reads wrong on a workshop RSVP, so
      // the DEFAULT template no longer uses it; new events get {{rsvpName}},
      // which is correct for any RSVP. All three are registered in
      // TEMPLATE_VARIABLES and getSamplePreviewVariables, so the editor lists
      // them and Preview renders them exactly as the send will.
      const itemWord = itemCount === 1 ? "session" : "sessions";
      const dinnerWord = itemCount === 1 ? "dinner" : "dinners";
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
            rsvpName: campaign.name,
            dinnerWord,
            itemWord,
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
              templateSlug: RSVP_INVITATION_SLUG,
              triggeredByUserId: session.user.id,
            },
          });
          sent += 1;
        } catch (err) {
          failed += 1;
          apiLogger.error({ err, eventId, campaignId, inviteId: inv.id }, "rsvp-send:recipient-failed");
        }
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "SEND",
            entityType: "RSVP_INVITE",
            entityId: parsed.data.inviteId
              ? `send:${parsed.data.inviteId}`
              : `send:${parsed.data.target}`,
            changes: {
              campaignId,
              target: parsed.data.target,
              inviteId: parsed.data.inviteId,
              sent,
              failed,
              skippedRecentlyInvited,
            },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-send:audit-failed"));

      apiLogger.info(
        {
          eventId,
          campaignId,
          target: parsed.data.target,
          inviteId: parsed.data.inviteId,
          sent,
          failed,
          skippedRecentlyInvited,
        },
        "rsvp-send:done",
      );
      return NextResponse.json({ sent, failed, skippedRecentlyInvited });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-send:failed");
    return NextResponse.json({ error: "Failed to send invitations" }, { status: 500 });
  }
}
