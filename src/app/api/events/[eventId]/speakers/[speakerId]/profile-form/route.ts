/**
 * Speaker profile form — organizer side (Aug 4, 2026).
 *
 *   GET   → the speaker's form status + copyable link (null when not minted)
 *   POST  → find-or-create the token, then EMAIL the personalized link via
 *           the editable `speaker-profile-form-request` template (optional
 *           subject/message override). A send failure surfaces (502) — the
 *           whole point is knowing the speaker got the link.
 *   PATCH → { reopen: true } flips SUBMITTED → PENDING (audited) so the
 *           speaker can fix/replace what they sent.
 *
 * Mirrors the reimbursement console flow, scoped to one speaker (the
 * organizer sends "from the speaker" page).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  sendEmail,
  getEventTemplate,
  renderAndWrap,
  renderMessageValue,
  brandingFrom,
  brandingCc,
} from "@/lib/email";
import { formatPersonName } from "@/lib/utils";
import { honorariumVars, readHonorarium } from "@/lib/reimbursement/constants";
import { generateProfileFormToken } from "@/lib/speaker-profile/server";

const TEMPLATE_SLUG = "speaker-profile-form-request";

type RouteParams = { params: Promise<{ eventId: string; speakerId: string }> };

const sendSchema = z.object({
  subject: z.string().max(500).optional(),
  message: z.string().max(10000).optional(),
});

function formLink(appUrl: string, slug: string, token: string): string {
  return `${appUrl}/e/${slug}/speaker-form/${token}`;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:GET" });
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:GET" });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, slug: true, organizationId: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    return await runWithTenant(event.organizationId, async () => {
      const form = await db.speakerProfileForm.findFirst({
        where: { speakerId, eventId },
        select: { id: true, token: true, status: true, submittedAt: true, createdAt: true },
      });
      if (!form) return NextResponse.json({ form: null });
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      return NextResponse.json({
        form: {
          id: form.id,
          status: form.status,
          submittedAt: form.submittedAt,
          createdAt: form.createdAt,
          link: formLink(appUrl, event.slug, form.token),
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-form:GET failed");
    return NextResponse.json({ error: "Failed to load the profile form" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:POST" });
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:POST" });
    if (denied) return denied;

    const rl = checkRateLimit({ key: `speaker-profile-form-send:${session.user.id}`, limit: 30, windowMs: 3600_000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "speaker-profile-form:send-rate-limited", userId: session.user.id, eventId });
      return NextResponse.json(
        { error: "Too many sends. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "speaker-profile-form:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, slug: true, name: true, organizationId: true, organization: { select: { name: true } } },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    return await runWithTenant(event.organizationId, async () => {
      const speaker = await db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          honorariumAmount: true,
          honorariumCurrency: true,
        },
      });
      if (!speaker) {
        apiLogger.warn({ msg: "speaker-profile-form:speaker-not-found", eventId, speakerId });
        return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
      }
      if (!speaker.email) {
        apiLogger.warn({ msg: "speaker-profile-form:no-speaker-email", eventId, speakerId });
        return NextResponse.json(
          { error: "This speaker has no email address on file.", code: "NO_SPEAKER_EMAIL" },
          { status: 400 },
        );
      }

      // Find-or-create the token (one form per speaker; the link stays stable
      // across resends so an earlier email keeps working).
      let form = await db.speakerProfileForm.findFirst({
        where: { speakerId, eventId },
        select: { id: true, token: true, status: true },
      });
      if (!form) {
        form = await db.speakerProfileForm.create({
          data: {
            eventId,
            organizationId: event.organizationId,
            speakerId,
            token: generateProfileFormToken(),
            createdById: session.user.id,
          },
          select: { id: true, token: true, status: true },
        });
      }

      const tpl = await getEventTemplate(eventId, TEMPLATE_SLUG);
      if (!tpl) {
        apiLogger.error({ msg: "speaker-profile-form:template-missing", eventId });
        return NextResponse.json({ error: "Email template not found" }, { status: 500 });
      }

      const sender = await db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, emailSignature: true },
      });
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const profileFormLink = formLink(appUrl, event.slug, form.token);
      const branding = tpl.branding;
      const subject = parsed.data.subject?.trim() || tpl.subject;
      const personalMessage = parsed.data.message?.trim() || "";
      const organizerName =
        event.organization?.name ||
        `${sender?.firstName ?? ""} ${sender?.lastName ?? ""}`.trim() ||
        "Event Organizer";
      const rawHtmlKeys = new Set(["personalMessage", "profileFormLink", "organizerSignature"]);

      const vars: Record<string, string> = {
        firstName: speaker.firstName,
        lastName: speaker.lastName,
        speakerName: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
        email: speaker.email,
        // Every speaker send carries the agreed fee (Sep 3, 2026).
        ...honorariumVars(readHonorarium(speaker)),
        eventName: event.name,
        profileFormLink,
        personalMessage,
        organizerName,
        organizerSignature: sender?.emailSignature || "",
      };
      vars.personalMessage = renderMessageValue(personalMessage, vars, { isHtml: true, rawHtmlKeys });
      const rendered = renderAndWrap(
        { subject, htmlContent: tpl.htmlContent, textContent: tpl.textContent },
        vars,
        branding,
        rawHtmlKeys,
      );
      const result = await sendEmail({
        to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
        cc: brandingCc(branding, [{ email: speaker.email }]),
        from: brandingFrom(branding),
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
        logContext: {
          organizationId: session.user.organizationId,
          eventId,
          entityType: "SPEAKER",
          entityId: speakerId,
          templateSlug: TEMPLATE_SLUG,
          triggeredByUserId: session.user.id,
        },
      });
      if (!result.success) {
        apiLogger.error({ msg: "speaker-profile-form:send-failed", eventId, speakerId, error: result.error });
        return NextResponse.json(
          { error: "Failed to send the form email. Please try again.", code: "EMAIL_SEND_FAILED" },
          { status: 502 },
        );
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "SEND",
            entityType: "Speaker",
            entityId: speakerId,
            changes: { send: "speaker-profile-form-request", recipient: speaker.email, ip: getClientIp(req) },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) => apiLogger.error({ err, speakerId }, "speaker-profile-form:audit-failed"));

      apiLogger.info({ msg: "speaker-profile-form:sent", eventId, speakerId });
      return NextResponse.json({ success: true, link: profileFormLink, status: form.status, sentTo: speaker.email });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-form:POST failed");
    return NextResponse.json({ error: "Failed to send the profile form" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, speakerId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:PATCH" });
    if ("error" in orgGuard) return orgGuard.error;
    const denied = denyReviewer(session, { route: "events/[eventId]/speakers/[speakerId]/profile-form:PATCH" });
    if (denied) return denied;

    const body = await req.json().catch(() => ({}));
    if (body?.reopen !== true) {
      apiLogger.warn({ msg: "speaker-profile-form:invalid-patch", eventId, speakerId });
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    return await runWithTenant(event.organizationId, async () => {
      const reopened = await db.speakerProfileForm.updateMany({
        where: { speakerId, eventId, status: "SUBMITTED" },
        data: { status: "PENDING" },
      });
      if (reopened.count === 0) {
        apiLogger.warn({ msg: "speaker-profile-form:nothing-to-reopen", eventId, speakerId });
        return NextResponse.json({ error: "No submitted form to reopen." }, { status: 400 });
      }
      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "Speaker",
            entityId: speakerId,
            changes: { profileForm: "reopened", ip: getClientIp(req) },
            ipAddress: getClientIp(req),
          },
        })
        .catch((err) => apiLogger.error({ err, speakerId }, "speaker-profile-form:audit-failed"));
      apiLogger.info({ msg: "speaker-profile-form:reopened", eventId, speakerId });
      return NextResponse.json({ success: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "speaker-profile-form:PATCH failed");
    return NextResponse.json({ error: "Failed to reopen the form" }, { status: 500 });
  }
}
