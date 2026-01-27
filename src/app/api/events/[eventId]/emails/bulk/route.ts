import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";

const bulkEmailSchema = z.object({
  recipientType: z.enum(["speakers", "registrations"]),
  recipientIds: z.array(z.string()).optional(), // If empty, send to all
  emailType: z.enum(["invitation", "agreement", "confirmation", "reminder", "custom"]),
  customSubject: z.string().optional(),
  customMessage: z.string().optional(),
  filters: z
    .object({
      status: z.string().optional(),
      ticketTypeId: z.string().optional(),
    })
    .optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([
      params,
      auth(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = bulkEmailSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { recipientType, recipientIds, emailType, customSubject, customMessage, filters } =
      validated.data;

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true, email: true },
    });

    const organizerName = user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : "Event Organizer";
    const organizerEmail = user?.email || "";
    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "TBA";
    const eventVenue = event.venue || "TBA";

    let recipients: Array<{ id: string; email: string; name: string; ticketType?: string }> = [];
    let successCount = 0;
    let failureCount = 0;
    const errors: Array<{ email: string; error: string }> = [];

    if (recipientType === "speakers") {
      const speakers = await db.speaker.findMany({
        where: {
          eventId,
          ...(recipientIds && recipientIds.length > 0 ? { id: { in: recipientIds } } : {}),
          ...(filters?.status ? { status: filters.status as any } : {}),
        },
      });

      recipients = speakers.map((s) => ({
        id: s.id,
        email: s.email,
        name: `${s.firstName} ${s.lastName}`,
      }));
    } else {
      const registrations = await db.registration.findMany({
        where: {
          eventId,
          ...(recipientIds && recipientIds.length > 0 ? { id: { in: recipientIds } } : {}),
          ...(filters?.status ? { status: filters.status as any } : {}),
          ...(filters?.ticketTypeId ? { ticketTypeId: filters.ticketTypeId } : {}),
        },
        include: {
          ticketType: true,
          attendee: true,
        },
      });

      recipients = registrations.map((r) => ({
        id: r.id,
        email: r.attendee.email,
        name: `${r.attendee.firstName} ${r.attendee.lastName}`,
        ticketType: r.ticketType?.name,
      }));
    }

    if (recipients.length === 0) {
      return NextResponse.json(
        { error: "No recipients found matching the criteria" },
        { status: 400 }
      );
    }

    // Send emails to each recipient
    for (const recipient of recipients) {
      try {
        let emailContent;

        if (recipientType === "speakers") {
          switch (emailType) {
            case "invitation":
              emailContent = emailTemplates.speakerInvitation({
                speakerName: recipient.name,
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
                speakerName: recipient.name,
                eventName: event.name,
                eventDate,
                eventVenue,
                organizerName,
                organizerEmail,
              });
              break;
            case "custom":
              if (!customSubject || !customMessage) {
                throw new Error("Custom emails require subject and message");
              }
              emailContent = emailTemplates.customNotification({
                recipientName: recipient.name,
                subject: customSubject,
                message: customMessage,
                eventName: event.name,
              });
              break;
            default:
              throw new Error("Invalid email type for speakers");
          }
        } else {
          switch (emailType) {
            case "confirmation":
              emailContent = emailTemplates.registrationConfirmation({
                attendeeName: recipient.name,
                eventName: event.name,
                eventDate,
                eventVenue,
                ticketType: recipient.ticketType || "General Admission",
                registrationId: recipient.id.slice(-8).toUpperCase(),
              });
              break;
            case "reminder":
              const daysUntil = event.startDate
                ? Math.ceil(
                    (new Date(event.startDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                  )
                : 1;
              emailContent = emailTemplates.eventReminder({
                recipientName: recipient.name,
                eventName: event.name,
                eventDate,
                eventVenue,
                eventAddress: event.address || undefined,
                daysUntilEvent: Math.max(daysUntil, 1),
              });
              break;
            case "custom":
              if (!customSubject || !customMessage) {
                throw new Error("Custom emails require subject and message");
              }
              emailContent = emailTemplates.customNotification({
                recipientName: recipient.name,
                subject: customSubject,
                message: customMessage,
                eventName: event.name,
              });
              break;
            default:
              throw new Error("Invalid email type for registrations");
          }
        }

        const result = await sendEmail({
          to: [{ email: recipient.email, name: recipient.name }],
          subject: emailContent.subject,
          htmlContent: emailContent.htmlContent,
          textContent: emailContent.textContent,
          replyTo:
            recipientType === "speakers" && organizerEmail
              ? { email: organizerEmail, name: organizerName }
              : undefined,
        });

        if (result.success) {
          successCount++;
        } else {
          failureCount++;
          errors.push({ email: recipient.email, error: result.error || "Unknown error" });
        }
      } catch (error) {
        failureCount++;
        errors.push({
          email: recipient.email,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // Log the bulk action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "BULK_EMAIL_SENT",
        entityType: recipientType === "speakers" ? "Speaker" : "Registration",
        entityId: eventId,
        changes: {
          emailType,
          totalRecipients: recipients.length,
          successCount,
          failureCount,
          customSubject,
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: `Sent ${successCount} of ${recipients.length} emails`,
      stats: {
        total: recipients.length,
        sent: successCount,
        failed: failureCount,
      },
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending bulk emails" });
    return NextResponse.json(
      { error: "Failed to send bulk emails" },
      { status: 500 }
    );
  }
}
