import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";

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

    const [event, speaker, user] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
      }),
      db.speaker.findFirst({
        where: {
          id: speakerId,
          eventId,
        },
        include: {
          sessions: {
            include: {
              session: true,
            },
          },
        },
      }),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, email: true },
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

    const speakerName = `${speaker.firstName} ${speaker.lastName}`;
    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "TBA";
    const eventVenue = event.venue || "TBA";
    const organizerName = user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : "Event Organizer";
    const organizerEmail = user?.email || "";

    // Get session details if speaker is assigned to sessions
    const sessionDetails = speaker.sessions.length > 0
      ? speaker.sessions.map((s) => s.session.name).join(", ")
      : undefined;

    let emailContent;

    switch (type) {
      case "invitation":
        emailContent = emailTemplates.speakerInvitation({
          speakerName,
          eventName: event.name,
          eventDate,
          eventVenue,
          personalMessage: customMessage,
          organizerName,
          organizerEmail,
        });
        break;

      case "agreement":
        emailContent = emailTemplates.speakerAgreement({
          speakerName,
          eventName: event.name,
          eventDate,
          eventVenue,
          sessionDetails,
          agreementLink: includeAgreementLink
            ? `${process.env.NEXT_PUBLIC_APP_URL || ""}/speaker-agreement/${speaker.id}`
            : undefined,
          organizerName,
          organizerEmail,
        });
        break;

      case "custom":
        if (!customSubject || !customMessage) {
          return NextResponse.json(
            { error: "Custom emails require subject and message" },
            { status: 400 }
          );
        }
        emailContent = emailTemplates.customNotification({
          recipientName: speakerName,
          subject: customSubject,
          message: customMessage,
          eventName: event.name,
        });
        break;

      default:
        return NextResponse.json({ error: "Invalid email type" }, { status: 400 });
    }

    const result = await sendEmail({
      to: [{ email: speaker.email, name: speakerName }],
      subject: emailContent.subject,
      htmlContent: emailContent.htmlContent,
      textContent: emailContent.textContent,
      replyTo: organizerEmail ? { email: organizerEmail, name: organizerName } : undefined,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Failed to send email" },
        { status: 500 }
      );
    }

    // Log the action
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
          subject: emailContent.subject,
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
