import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  sendEmail,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  brandingFrom,
  brandingCc,
} from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp, checkRateLimit, hashVerificationToken } from "@/lib/security";
import {
  buildPresenterAgreementContext,
  generatePresenterAgreementPdf,
  PRESENTER_AGREEMENT_PDF_MIME,
  PRESENTER_AGREEMENT_IDENTIFIER_PREFIX,
} from "@/lib/presenter-agreement";

const sendSchema = z.object({
  customMessage: z.string().max(5000).optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

/**
 * Send the Presenter Agreement (per-author) to the author of this abstract.
 * The agreement covers ALL of the author's abstracts for the event; the token
 * is minted on the author's Speaker id, so re-sending from any of their
 * abstracts targets the same acceptance record.
 *
 * denyReviewer gates this to management roles; buildEventAccessWhere scopes the
 * event (org for admins/organizers, all-events for an org-null super-admin) so
 * we never pass a null organizationId into Prisma.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const limit = checkRateLimit({
      key: `presenter-agreement-email:${session.user.id}`,
      limit: 200,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      apiLogger.warn({
        msg: "events/abstracts/presenter-agreement:rate-limited",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
      return NextResponse.json(
        { error: "Email rate limit reached. Maximum 200 emails per hour." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const validated = sendSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({
        msg: "events/abstracts/presenter-agreement:zod-validation-failed",
        errors: validated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const [event, abstract, user] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, name: true, slug: true, venue: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: {
          id: true,
          speakerId: true,
          speaker: {
            select: { id: true, email: true, firstName: true, lastName: true, additionalEmail: true },
          },
        },
      }),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, email: true, emailSignature: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    const speaker = abstract.speaker;
    if (!speaker || !speaker.email) {
      return NextResponse.json(
        { error: "This abstract has no author with an email address to send the agreement to." },
        { status: 400 },
      );
    }
    const speakerId = speaker.id;

    const context = await buildPresenterAgreementContext(eventId, speakerId);
    if (!context) {
      return NextResponse.json({ error: "Failed to build agreement details" }, { status: 500 });
    }

    // Personalized PDF attachment (inline HTML → PDF; default HTML always applies).
    let attachments: { name: string; content: string; contentType?: string }[] | undefined;
    try {
      const doc = await generatePresenterAgreementPdf({ eventId, speakerId });
      if (!doc) {
        return NextResponse.json({ error: "Failed to generate agreement PDF" }, { status: 500 });
      }
      attachments = [
        { name: doc.filename, content: doc.buffer.toString("base64"), contentType: PRESENTER_AGREEMENT_PDF_MIME },
      ];
    } catch (docErr) {
      apiLogger.error({ err: docErr, msg: "presenter-agreement:generate-failed", eventId, speakerId });
      return NextResponse.json(
        { error: docErr instanceof Error ? docErr.message : "Failed to generate agreement PDF" },
        { status: 500 },
      );
    }

    // Mint the hashed, one-time token keyed on the AUTHOR ONLY AFTER context +
    // PDF succeed (M1) — so a render failure never leaves an orphaned live
    // token. Rotates any prior token for the same author.
    let agreementLink = "";
    try {
      const identifier = `${PRESENTER_AGREEMENT_IDENTIFIER_PREFIX}${speakerId}`;
      const rawToken = crypto.randomBytes(32).toString("hex");
      const hashedToken = hashVerificationToken(rawToken);
      await db.$transaction([
        db.verificationToken.deleteMany({ where: { identifier } }),
        db.verificationToken.create({
          data: {
            identifier,
            token: hashedToken,
            expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          },
        }),
      ]);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
      agreementLink = `${appUrl}/e/${event.slug}/presenter-agreement?token=${rawToken}`;
    } catch (tokenErr) {
      apiLogger.error({
        err: tokenErr,
        msg: "Failed to create presenter agreement token",
        speakerId,
        eventId,
      });
      return NextResponse.json({ error: "Failed to generate agreement link" }, { status: 500 });
    }

    const organizerName =
      user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : "Event Organizer";
    const organizerEmail = user?.email || "";

    const vars: Record<string, string> = {
      title: context.title,
      firstName: context.firstName,
      lastName: context.lastName,
      presenterName: context.presenterName,
      presenterEmail: context.presenterEmail,
      eventName: event.name,
      eventDateRange: context.eventDateRange,
      eventVenue: event.venue || "TBA",
      abstractTitles: context.abstractTitles,
      abstractCount: context.abstractCount,
      agreementLink,
      organizerName,
      organizerEmail,
      organizerSignature: user?.emailSignature ?? "",
      personalMessage: validated.data.customMessage || "",
    };

    const tpl =
      (await getEventTemplate(eventId, "presenter-agreement")) ||
      getDefaultTemplate("presenter-agreement");
    if (!tpl) {
      return NextResponse.json({ error: "Email template not found" }, { status: 500 });
    }

    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: event.name };
    const rendered = renderAndWrap(
      tpl,
      vars,
      branding,
      new Set(["organizerSignature", "personalMessage"]),
    );

    const result = await sendEmail({
      to: [{ email: speaker.email, name: context.presenterName }],
      cc: brandingCc(branding, [{ email: speaker.email }], [speaker.additionalEmail]),
      ...rendered,
      from: brandingFrom(branding),
      replyTo: organizerEmail ? { email: organizerEmail, name: organizerName } : undefined,
      attachments,
      emailType: "presenter_agreement",
      stream: "transactional",
      logContext: {
        organizationId: session.user.organizationId ?? null,
        eventId,
        entityType: "SPEAKER",
        entityId: speakerId,
        templateSlug: "presenter-agreement",
        triggeredByUserId: session.user.id,
      },
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to send email" }, { status: 500 });
    }

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "EMAIL_SENT",
        entityType: "Speaker",
        entityId: speakerId,
        changes: {
          emailType: "presenter-agreement",
          abstractId,
          recipient: speaker.email,
          subject: rendered.subject,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: `Presenter agreement sent to ${speaker.email}`,
      messageId: result.messageId,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending presenter agreement email" });
    return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
  }
}
