import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp, checkRateLimit, hashVerificationToken } from "@/lib/security";
import { buildSpeakerEmailContext, generateSpeakerAgreementDocx, SPEAKER_AGREEMENT_DOCX_MIME } from "@/lib/speaker-agreement";

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

    // For agreement emails, mail-merge the personalized .docx and attach it.
    let attachments: { name: string; content: string; contentType?: string }[] | undefined;
    if (type === "agreement") {
      try {
        const doc = await generateSpeakerAgreementDocx({ eventId, speakerId });
        if (!doc) {
          return NextResponse.json(
            {
              error:
                "Upload a speaker agreement template under Event Settings → Email Branding → Speaker Agreement Template first.",
            },
            { status: 400 },
          );
        }
        attachments = [
          {
            name: doc.filename,
            content: doc.buffer.toString("base64"),
            contentType: SPEAKER_AGREEMENT_DOCX_MIME,
          },
        ];
      } catch (docErr) {
        apiLogger.error({ err: docErr, msg: "speaker-agreement:generate-failed", eventId, speakerId });
        return NextResponse.json(
          { error: docErr instanceof Error ? docErr.message : "Failed to generate agreement document" },
          { status: 500 },
        );
      }
    }

    const result = await sendEmail({
      to: [{ email: speaker.email, name: `${speaker.firstName} ${speaker.lastName}` }],
      ...rendered,
      from: brandingFrom(branding),
      replyTo: organizerEmail ? { email: organizerEmail, name: organizerName } : undefined,
      attachments,
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
