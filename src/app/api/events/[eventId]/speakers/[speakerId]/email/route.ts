import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, renderMessageValue, brandingFrom, brandingCc } from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit } from "@/lib/security";
import { normalizeEmail, repointOrgContactEmail } from "@/lib/email-change";
import {
  buildAgreementBlock,
  buildSpeakerEmailContext,
  generateSpeakerAgreementDocx,
  generateSpeakerAgreementPdf,
  mintSpeakerAgreementLink,
  pickAgreementAttachmentMode,
  templateUsesAgreementBlock,
  templateUsesAgreementAttachment,
  SPEAKER_AGREEMENT_DOCX_MIME,
  SPEAKER_AGREEMENT_PDF_MIME,
} from "@/lib/speaker-agreement";
import { validateManualAttachments } from "@/lib/email-attachments";
import { MAX_MANUAL_ATTACHMENTS } from "@/lib/email-attachment-limits";

const sendEmailSchema = z.object({
  type: z.enum(["invitation", "agreement", "custom"]),
  customSubject: z.string().optional(),
  customMessage: z.string().optional(),
  includeAgreementLink: z.boolean().optional(),
  // Operator-picked file attachments (PDF/DOC/DOCX) — surfaced in the UI on the
  // invitation dialog. Base64 in the body (same shape as the bulk-email path);
  // re-validated by MIME + magic bytes in validateManualAttachments below.
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        content: z.string().min(1),
        contentType: z.string().min(1).max(150),
      }),
    )
    .max(MAX_MANUAL_ATTACHMENTS)
    .optional(),
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
      apiLogger.warn({ msg: "events/speakers/email:rate-limited", retryAfterSeconds: emailLimit.retryAfterSeconds });
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

    // Validate operator-picked attachments (PDF/DOC/DOCX, ≤3 files, ≤10 MB
    // total, magic-byte checked). These merge into whatever the chosen email
    // type already attaches (e.g. the agreement doc).
    const manualAttachments = validateManualAttachments(validated.data.attachments);
    if (!manualAttachments.ok) {
      apiLogger.warn({
        msg: "events/speakers/email:attachment-rejected",
        eventId,
        speakerId,
        code: manualAttachments.code,
      });
      return NextResponse.json(
        { error: manualAttachments.error, code: manualAttachments.code },
        { status: 400 },
      );
    }

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
    // (shared helper — the bulk pipeline mints through the same code).
    let agreementLink = "";
    if (type === "agreement" || includeAgreementLink) {
      try {
        // Only the strict agreement type ROTATES (latest re-send wins); an
        // includeAgreementLink custom send mints additively so it can't
        // invalidate a previously-delivered link (review M1).
        agreementLink = await mintSpeakerAgreementLink(speaker.id, event.slug, {
          rotate: type === "agreement",
        });
      } catch (tokenErr) {
        apiLogger.error({ err: tokenErr, msg: "Failed to create speaker agreement token", speakerId: speaker.id, eventId });
        return NextResponse.json({ error: "Failed to generate agreement link" }, { status: 500 });
      }
    }

    // Build the rich speaker context (title, full name, presentation block,
    // etc.) for EVERY type. Custom emails used to skip it, so a customized
    // custom-notification template using {{presentationDetails}} rendered an
    // empty block (organizer-reported bug, July 16 2026).
    const context = await buildSpeakerEmailContext(eventId, speakerId);

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
      // Title prefix ("Dr.", "Prof.", ...) — for invitation/agreement we use
      // the context's pre-formatted value; for custom emails (no context)
      // fall back to formatting the raw enum on the speaker row so the
      // {{title}} placeholder still renders correctly.
      title: context?.title ?? getTitleLabel(speaker.title),
      speakerName: context?.speakerName ?? `${speaker.firstName} ${speaker.lastName}`,
      presentationDetails: context?.presentationDetails ?? "",
      presentationDetailsText: context?.presentationDetailsText ?? "",
      moderatorDetails: context?.moderatorDetails ?? "",
      moderatorDetailsText: context?.moderatorDetailsText ?? "",
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

    // {{agreementBlock}} — the invitation (or any speaker template) can carry
    // a one-liner + "Review & Agree" CTA. The link is minted ON DEMAND, only
    // when the template actually uses an agreement token and the speaker
    // hasn't signed yet — an unrelated send must never rotate (invalidate) a
    // previously-emailed agreement link. A signed speaker gets a green
    // "already accepted" note instead of a re-ask.
    const templateWantsAgreement = templateUsesAgreementBlock(
      tpl.subject,
      tpl.htmlContent,
      tpl.textContent,
    );
    if (!agreementLink && !speaker.agreementAcceptedAt && templateWantsAgreement) {
      try {
        // Additive mint (rotate: false) — an invitation carrying
        // {{agreementBlock}} must not kill a previously-delivered agreement
        // link (review M1); acceptance sweeps all of the speaker's tokens.
        agreementLink = await mintSpeakerAgreementLink(speaker.id, event.slug, { rotate: false });
        vars.agreementLink = agreementLink;
      } catch (tokenErr) {
        apiLogger.error({ err: tokenErr, msg: "Failed to create speaker agreement token", speakerId: speaker.id, eventId });
        return NextResponse.json({ error: "Failed to generate agreement link" }, { status: 500 });
      }
    }
    const agreementBlock = buildAgreementBlock({
      agreementLink,
      agreementAcceptedAt: speaker.agreementAcceptedAt,
    });
    vars.agreementBlock = agreementBlock.html;
    vars.agreementBlockText = agreementBlock.text;
    // Invisible marker — must render as nothing (renderTemplate leaves
    // unknown tokens literal).
    vars.agreementAttachment = "";

    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: vars.eventName as string };

    // message + personalMessage are pre-rendered FINAL HTML via
    // renderMessageValue, so tokens the organizer typed into the free-text
    // message ({{organizerSignature}}, {{presentationDetails}}, …) resolve
    // instead of staying literal (July 16, 2026). Historical escaping kept
    // per key: {{personalMessage}} always rendered the typed message raw
    // (isHtml: true); {{message}} escapes its literal text.
    const rawHtmlKeys = new Set([
      "presentationDetails",
      "moderatorDetails",
      "organizerSignature",
      "personalMessage",
      "message",
    ]);
    if (customMessage) {
      vars.personalMessage = renderMessageValue(customMessage, vars, { isHtml: true, rawHtmlKeys });
      if ("message" in vars) {
        vars.message = renderMessageValue(customMessage, vars, { rawHtmlKeys });
      }
    }
    const rendered = renderAndWrap(tpl, vars, branding, rawHtmlKeys);

    // Seed with the operator-picked files; the agreement branch appends its
    // generated document on top.
    const attachments: { name: string; content: string; contentType?: string }[] = [
      ...manualAttachments.attachments,
    ];

    // Personalized agreement attachment. Precedence: explicit .docx upload
    // wins; else inline HTML → PDF. Two intensities (owner decision July 16):
    //   - agreement type: STRICT — no configured content is a 400, a
    //     generation failure fails the send (unchanged behavior).
    //   - any other type whose template carries an agreement token (e.g. the
    //     invitation's {{agreementBlock}}), for an UNSIGNED speaker: attach
    //     when possible — no content or a generation failure just sends the
    //     email with the CTA alone (the acceptance page shows the full text).
    const agreementAttachMode = pickAgreementAttachmentMode({
      hasDocxTemplate: Boolean(event.speakerAgreementTemplate),
      hasInlineHtml: Boolean(event.speakerAgreementHtml?.trim()),
    });
    const strictAgreement = type === "agreement";
    // {{agreementAttachment}} — invisible marker: attach the personalized
    // agreement WITHOUT the Review & Agree block and WITHOUT a link mint.
    const templateWantsAttachmentOnly = templateUsesAgreementAttachment(
      tpl.subject,
      tpl.htmlContent,
      tpl.textContent,
    );
    const wantsAgreementAttachment =
      strictAgreement ||
      ((templateWantsAgreement || templateWantsAttachmentOnly) &&
        !speaker.agreementAcceptedAt);
    if (strictAgreement && !agreementAttachMode) {
      return NextResponse.json(
        {
          error:
            "Upload a .docx template or add inline agreement HTML (Event → Content → Speaker Agreement) first.",
        },
        { status: 400 },
      );
    }
    if (wantsAgreementAttachment && !agreementAttachMode) {
      apiLogger.info({
        msg: "speaker-email:agreement-attachment-skipped-no-content",
        eventId,
        speakerId,
        type,
      });
    }
    if (wantsAgreementAttachment && agreementAttachMode) {
      try {
        const doc =
          agreementAttachMode === "docx"
            ? await generateSpeakerAgreementDocx({ eventId, speakerId })
            : await generateSpeakerAgreementPdf({ eventId, speakerId });
        if (!doc) throw new Error("Failed to generate agreement document");
        attachments.push({
          name: doc.filename,
          content: doc.buffer.toString("base64"),
          contentType:
            agreementAttachMode === "docx"
              ? SPEAKER_AGREEMENT_DOCX_MIME
              : SPEAKER_AGREEMENT_PDF_MIME,
        });
      } catch (docErr) {
        if (strictAgreement) {
          apiLogger.error({ err: docErr, msg: "speaker-agreement:generate-failed", eventId, speakerId, mode: agreementAttachMode });
          return NextResponse.json(
            { error: docErr instanceof Error ? docErr.message : "Failed to generate agreement document" },
            { status: 500 },
          );
        }
        // Best-effort on non-agreement types: the CTA still works.
        apiLogger.error({
          err: docErr,
          msg: "speaker-email:soft-agreement-attach-failed",
          eventId,
          speakerId,
          type,
          mode: agreementAttachMode,
        });
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
      attachments: attachments.length ? attachments : undefined,
      emailType: `speaker_${type.replace(/-/g, "_")}`,
      stream: "transactional",
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

    // Fire-and-forget (M13): the email is already sent — a transient
    // audit-insert blip must not report a delivered email as a 500.
    db.auditLog
      .create({
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
            attachmentCount: attachments.length,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        apiLogger.error(
          { err, eventId, speakerId: speaker.id },
          "speaker-email:audit-write-failed",
        ),
      );

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
      apiLogger.warn({ msg: "events/speakers/email:change-rate-limited", retryAfterSeconds: changeLimit.retryAfterSeconds });
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
        select: { id: true, email: true, userId: true, firstName: true, lastName: true, sourceRegistrationId: true },
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

      // Companion email sync (speaker-as-attendee Fix B) — keep the
      // auto-created Faculty companion's attendee email in step with the
      // speaker's, so the badge/check-in/survey identity doesn't drift. ONLY
      // the SPEAKER_COMPANION row — a real email-linked registration is the
      // person's own and changes via the registration email-change flow.
      let companionSynced = false;
      if (speaker.sourceRegistrationId) {
        const companion = await tx.registration.findFirst({
          where: { id: speaker.sourceRegistrationId, createdSource: "SPEAKER_COMPANION" },
          select: { attendeeId: true },
        });
        if (companion) {
          await tx.attendee.update({ where: { id: companion.attendeeId }, data: { email: newEmail } });
          companionSynced = true;
        }
      }

      return { updatedSpeaker, contactAction, companionSynced };
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
            companionSynced: result.companionSynced,
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
      companionSynced: result.companionSynced,
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
