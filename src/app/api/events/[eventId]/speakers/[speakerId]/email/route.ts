import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom, brandingCc } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit, hashVerificationToken } from "@/lib/security";
import { normalizeEmail, repointOrgContactEmail } from "@/lib/email-change";
import {
  buildSpeakerEmailContext,
  generateSpeakerAgreementDocx,
  generateSpeakerAgreementPdf,
  pickAgreementAttachmentMode,
  SPEAKER_AGREEMENT_DOCX_MIME,
  SPEAKER_AGREEMENT_PDF_MIME,
} from "@/lib/speaker-agreement";

const sendEmailSchema = z.object({
  type: z.enum(["invitation", "agreement", "custom"]),
  customSubject: z.string().optional(),
  customMessage: z.string().optional(),
  includeAgreementLink: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; speakerId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const emailLimit = checkRateLimit({
      key: `speaker-email:${session.user.id}`,
      limit: 200,
      windowMs: 60 * 60 * 1000,
    });
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { error: "Email rate limit reached. Maximum 200 emails per hour." },
        { status: 429, headers: { "Retry-After": String(emailLimit.retryAfterSeconds) } }
      );
    }

    const [event, speaker, user] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
      }),
      db.speaker.findFirst({
        where: { id: speakerId, eventId },
        include: { sessions: { include: { session: true } } },
      }),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, email: true, emailSignature: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = sendEmailSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "events/speakers/email:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { type, customSubject, customMessage, includeAgreementLink } = validated.data;

    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })
      : "TBA";
    const organizerName = user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}` : "Event Organizer";
    const organizerEmail = user?.email || "";
    const sessionDetails = speaker.sessions.length > 0
      ? speaker.sessions.map((s) => s.session.name).join(", ") : "";

    // Generate a hashed, one-time verification token for agreement emails
    let agreementLink = "";
    if (type === "agreement" || includeAgreementLink) {
      try {
        const identifier = `speaker-agreement:${speaker.id}`;
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = hashVerificationToken(rawToken);

        // Atomically rotate the token: delete any existing tokens, then create new one
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
        agreementLink = `${appUrl}/e/${event.slug}/speaker-agreement?token=${rawToken}`;
      } catch (tokenErr) {
        apiLogger.error({ err: tokenErr, msg: "Failed to create speaker agreement token", speakerId: speaker.id, eventId });
        return NextResponse.json({ error: "Failed to generate agreement link" }, { status: 500 });
      }
    }

    // Build the rich speaker context (title, full name, presentation block, etc.)
    // for invitation/agreement templates. Custom emails get the basic vars only.
    const context = type === "custom" ? null : await buildSpeakerEmailContext(eventId, speakerId);

    const vars: Record<string, string> = {
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      eventName: event.name,
      eventDate,
      eventVenue: event.venue || "TBA",
      organizerName,
      organizerEmail,
      personalMessage: customMessage || "",
      sessionDetails,
      agreementLink,
      title: context?.title ?? "",
      speakerName: context?.speakerName ?? `${speaker.firstName} ${speaker.lastName}`,
      presentationDetails: context?.presentationDetails ?? "",
      presentationDetailsText: context?.presentationDetailsText ?? "",
      organizerSignature: user?.emailSignature ?? "",
    };

    const slugMap: Record<string, string> = {
      invitation: "speaker-invitation",
      agreement: "speaker-agreement",
      custom: "custom-notification",
    };

    if (type === "custom") {
      if (!customSubject || !customMessage) {
        return NextResponse.json(
          { error: "Custom emails require subject and message" },
          { status: 400 }
        );
      }
      vars.subject = customSubject;
      vars.message = customMessage;
    }

    const tpl = await getEventTemplate(eventId, slugMap[type]) || getDefaultTemplate(slugMap[type]);
    if (!tpl) {
      return NextResponse.json({ error: "Email template not found" }, { status: 500 });
    }

    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: vars.eventName as string };
    const rendered = renderAndWrap(
      tpl,
      vars,
      branding,
      new Set(["presentationDetails", "organizerSignature", "personalMessage"]),
    );

    // For agreement emails, attach a personalized agreement.
    // Precedence: explicit .docx upload wins; else inline HTML → PDF.
    let attachments: { name: string; content: string; contentType?: string }[] | undefined;
    if (type === "agreement") {
      const mode = pickAgreementAttachmentMode({
        hasDocxTemplate: Boolean(event.speakerAgreementTemplate),
        hasInlineHtml: Boolean(event.speakerAgreementHtml?.trim()),
      });
      if (!mode) {
        return NextResponse.json(
          {
            error:
              "Upload a .docx template or add inline agreement HTML (Event → Content → Speaker Agreement) first.",
          },
          { status: 400 },
        );
      }
      try {
        if (mode === "docx") {
          const doc = await generateSpeakerAgreementDocx({ eventId, speakerId });
          if (!doc) {
            return NextResponse.json(
              { error: "Failed to generate agreement document" },
              { status: 500 },
            );
          }
          attachments = [
            {
              name: doc.filename,
              content: doc.buffer.toString("base64"),
              contentType: SPEAKER_AGREEMENT_DOCX_MIME,
            },
          ];
        } else {
          const doc = await generateSpeakerAgreementPdf({ eventId, speakerId });
          if (!doc) {
            return NextResponse.json(
              { error: "Failed to generate agreement PDF" },
              { status: 500 },
            );
          }
          attachments = [
            {
              name: doc.filename,
              content: doc.buffer.toString("base64"),
              contentType: SPEAKER_AGREEMENT_PDF_MIME,
            },
          ];
        }
      } catch (docErr) {
        apiLogger.error({ err: docErr, msg: "speaker-agreement:generate-failed", eventId, speakerId, mode });
        return NextResponse.json(
          { error: docErr instanceof Error ? docErr.message : "Failed to generate agreement document" },
          { status: 500 },
        );
      }
    }

    const result = await sendEmail({
      to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
      cc: brandingCc(
        branding,
        [{ email: speaker.email }],
        [speaker.additionalEmail],
      ),
      ...rendered,
      from: brandingFrom(branding),
      replyTo: organizerEmail ? { email: organizerEmail, name: organizerName } : undefined,
      attachments,
      logContext: {
        organizationId: session.user.organizationId ?? null,
        eventId,
        entityType: "SPEAKER",
        entityId: speakerId,
        templateSlug: `speaker-${type}`,
        triggeredByUserId: session.user.id,
      },
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send email" },
        { status: 500 }
      );
    }

    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "EMAIL_SENT",
        entityType: "Speaker",
        entityId: speaker.id,
        changes: {
          emailType: type,
          recipient: speaker.email,
          subject: rendered.subject,
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: `Email sent to ${speaker.email}`,
      messageId: result.messageId,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending speaker email" });
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500 }
    );
  }
}

// PATCH changes the speaker's canonical email address. This is the
// dedicated flow that the general-purpose speaker PUT route rejects —
// see updateSpeakerSchema comment in ../route.ts. Performs collision
// check against Speaker.(eventId, email), User.email (globally unique),
// updates the linked User row if Speaker.userId is set, re-points the
// org's Contact row atomically, and writes an audit entry.
const changeEmailSchema = z.object({
  newEmail: z.string().email().max(255),
});

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, speakerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const changeLimit = checkRateLimit({
      key: `email-change:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!changeLimit.allowed) {
      return NextResponse.json(
        { error: "Email change rate limit reached. Maximum 30 per hour." },
        { status: 429, headers: { "Retry-After": String(changeLimit.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const parsed = changeEmailSchema.safeParse(body);
    if (!parsed.success) {
        apiLogger.warn({ msg: "events/speakers/email:zod-validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const newEmail = normalizeEmail(parsed.data.newEmail);
    if (!newEmail) {
      return NextResponse.json({ error: "Invalid email address", code: "INVALID_EMAIL" }, { status: 400 });
    }

    const [event, speaker] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true, organizationId: true },
      }),
      db.speaker.findFirst({
        where: { id: speakerId, eventId },
        select: { id: true, email: true, userId: true, firstName: true, lastName: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    if (!speaker) {
      return NextResponse.json({ error: "Speaker not found" }, { status: 404 });
    }

    const oldEmail = speaker.email.toLowerCase();
    if (oldEmail === newEmail) {
      return NextResponse.json({ error: "New email is the same as the current email", code: "NO_CHANGE" }, { status: 400 });
    }

    // Collision checks BEFORE the transaction so we return clean 409s
    // rather than P2002 constraint errors.
    const [speakerCollision, userCollision] = await Promise.all([
      db.speaker.findFirst({
        where: { eventId, email: newEmail, id: { not: speakerId } },
        select: { id: true },
      }),
      speaker.userId
        ? db.user.findFirst({
            where: { email: newEmail, id: { not: speaker.userId } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (speakerCollision) {
      return NextResponse.json(
        { error: "Another speaker in this event already uses that email", code: "SPEAKER_EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    if (userCollision) {
      return NextResponse.json(
        { error: "Another user account already uses that email", code: "USER_EMAIL_TAKEN" },
        { status: 409 }
      );
    }

    // When speaker.userId is null we don't pre-check User.email — an
    // unlinked speaker has no User row to cascade into. But a later
    // flow that tries to link them (speaker-register-to-account, etc.)
    // may surface a collision via P2002 at that point. Warn here so the
    // audit trail flags the risk.
    if (!speaker.userId) {
      const shadowUser = await db.user.findFirst({ where: { email: newEmail }, select: { id: true } });
      if (shadowUser) {
        apiLogger.warn({
          msg: "speaker email changed to an address already held by a User row — future link flow may fail",
          speakerId,
          eventId,
          existingUserId: shadowUser.id,
        });
      }
    }

    const result = await db.$transaction(async (tx) => {
      const updatedSpeaker = await tx.speaker.update({
        where: { id: speakerId },
        data: { email: newEmail },
      });

      if (speaker.userId) {
        await tx.user.update({
          where: { id: speaker.userId },
          data: { email: newEmail },
        });
      }

      const contactAction = await repointOrgContactEmail(tx, {
        organizationId: event.organizationId,
        oldEmail,
        newEmail,
      });

      return { updatedSpeaker, contactAction };
    });

    // Audit log — fire-and-forget to stay fast, errors only logged.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Speaker",
          entityId: speakerId,
          changes: {
            field: "email",
            before: oldEmail,
            after: newEmail,
            userCascaded: Boolean(speaker.userId),
            contactAction: result.contactAction,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) => apiLogger.warn({ msg: "speaker email-change audit log failed", err }));

    apiLogger.info({
      msg: "speaker email changed",
      eventId,
      speakerId,
      userCascaded: Boolean(speaker.userId),
      contactAction: result.contactAction,
    });

    return NextResponse.json({
      speaker: result.updatedSpeaker,
      userCascaded: Boolean(speaker.userId),
      contactAction: result.contactAction,
    });
  } catch (error) {
    // P2002 — race between collision check and transaction commit.
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "That email was just taken by another record. Try again.", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    apiLogger.error({ err: error, msg: "Error changing speaker email" });
    return NextResponse.json({ error: "Failed to change email" }, { status: 500 });
  }
}
