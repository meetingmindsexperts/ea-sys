import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";

const sendEmailSchema = z.object({
  type: z.enum(["confirmation", "reminder", "custom"]),
  customSubject: z.string().optional(),
  customMessage: z.string().optional(),
  daysUntilEvent: z.number().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; registrationId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, registrationId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, registration] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId,
        },
      }),
      db.registration.findFirst({
        where: {
          id: registrationId,
          eventId,
        },
        include: {
          ticketType: true,
          attendee: true,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!registration) {
      return NextResponse.json({ error: "Registration not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = sendEmailSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { type, customSubject, customMessage, daysUntilEvent } = validated.data;

    const attendeeName = `${registration.attendee.firstName} ${registration.attendee.lastName}`;
    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "TBA";
    const eventVenue = event.venue || "TBA";
    const ticketType = registration.ticketType?.name || "General Admission";

    let emailContent;

    switch (type) {
      case "confirmation":
        emailContent = emailTemplates.registrationConfirmation({
          attendeeName,
          eventName: event.name,
          eventDate,
          eventVenue,
          ticketType,
          registrationId: registration.id.slice(-8).toUpperCase(),
          additionalInfo: customMessage,
        });
        break;

      case "reminder":
        const days = daysUntilEvent ?? 1;
        emailContent = emailTemplates.eventReminder({
          recipientName: attendeeName,
          eventName: event.name,
          eventDate,
          eventVenue,
          eventAddress: event.address || undefined,
          daysUntilEvent: days,
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
          recipientName: attendeeName,
          subject: customSubject,
          message: customMessage,
          eventName: event.name,
        });
        break;

      default:
        return NextResponse.json({ error: "Invalid email type" }, { status: 400 });
    }

    const result = await sendEmail({
      to: [{ email: registration.attendee.email, name: attendeeName }],
      subject: emailContent.subject,
      htmlContent: emailContent.htmlContent,
      textContent: emailContent.textContent,
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
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          emailType: type,
          recipient: registration.attendee.email,
          subject: emailContent.subject,
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: `Email sent to ${registration.attendee.email}`,
      messageId: result.messageId,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending registration email" });
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500 }
    );
  }
}
