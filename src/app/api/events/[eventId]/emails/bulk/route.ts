import { NextResponse } from "next/server";
import { z } from "zod";
import { RegistrationStatus, SpeakerStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, emailTemplates } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";

const bulkEmailSchema = z.object({
  recipientType: z.enum(["speakers", "registrations", "reviewers"]),
  recipientIds: z.array(z.string().max(100)).optional(), // If empty, send to all
  emailType: z.enum(["invitation", "agreement", "confirmation", "reminder", "custom"]),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  filters: z
    .object({
      status: z.string().max(50).optional(),
      ticketTypeId: z.string().max(100).optional(),
    })
    .optional(),
});
const speakerStatusSchema = z.nativeEnum(SpeakerStatus);
const registrationStatusSchema = z.nativeEnum(RegistrationStatus);

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    // Parallelize initial operations: params, auth, and body parsing
    const [{ eventId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const bulkEmailRateLimit = checkRateLimit({
      key: `bulk-email:org:${session.user.organizationId}:event:${eventId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });

    if (!bulkEmailRateLimit.allowed) {
      return NextResponse.json(
        { error: "Bulk email limit reached. Maximum 20 sends per event per hour." },
        { status: 429, headers: { "Retry-After": String(bulkEmailRateLimit.retryAfterSeconds) } }
      );
    }

    const validated = bulkEmailSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { recipientType, recipientIds, emailType, customSubject, customMessage, filters } =
      validated.data;

    // Parallelize event and user fetch
    const [event, user] = await Promise.all([
      db.event.findFirst({
        where: {
          id: eventId,
          organizationId: session.user.organizationId!,
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

    if (recipientType === "reviewers") {
      // Reviewers are identified by event.settings.reviewerUserIds
      const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
      if (reviewerUserIds.length === 0) {
        return NextResponse.json(
          { error: "No reviewers assigned to this event" },
          { status: 400 }
        );
      }

      const reviewerUsers = await db.user.findMany({
        where: {
          id: { in: recipientIds && recipientIds.length > 0 ? recipientIds.filter((id) => reviewerUserIds.includes(id)) : reviewerUserIds },
          role: "REVIEWER",
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      });

      recipients = reviewerUsers.map((u) => ({
        id: u.id,
        email: u.email,
        name: `${u.firstName} ${u.lastName}`,
      }));
    } else if (recipientType === "speakers") {
      const parsedStatus = filters?.status ? speakerStatusSchema.safeParse(filters.status) : null;
      const status = parsedStatus?.success ? parsedStatus.data : undefined;

      const speakers = await db.speaker.findMany({
        where: {
          eventId,
          ...(recipientIds && recipientIds.length > 0 ? { id: { in: recipientIds } } : {}),
          ...(status && { status }),
        },
      });

      recipients = speakers.map((s) => ({
        id: s.id,
        email: s.email,
        name: `${s.firstName} ${s.lastName}`,
      }));
    } else {
      const parsedStatus = filters?.status ? registrationStatusSchema.safeParse(filters.status) : null;
      const status = parsedStatus?.success ? parsedStatus.data : undefined;

      const registrations = await db.registration.findMany({
        where: {
          eventId,
          ...(recipientIds && recipientIds.length > 0 ? { id: { in: recipientIds } } : {}),
          ...(status && { status }),
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

    // Helper function to generate email content for a recipient
    const generateEmailContent = (recipient: typeof recipients[0]) => {
      if (recipientType === "reviewers" || recipientType === "speakers") {
        switch (emailType) {
          case "invitation":
            return emailTemplates.speakerInvitation({
              speakerName: recipient.name,
              eventName: event.name,
              eventDate,
              eventVenue,
              personalMessage: customMessage,
              organizerName,
              organizerEmail,
            });
          case "agreement":
            return emailTemplates.speakerAgreement({
              speakerName: recipient.name,
              eventName: event.name,
              eventDate,
              eventVenue,
              organizerName,
              organizerEmail,
            });
          case "custom":
            if (!customSubject || !customMessage) {
              throw new Error("Custom emails require subject and message");
            }
            return emailTemplates.customNotification({
              recipientName: recipient.name,
              subject: customSubject,
              message: customMessage,
              eventName: event.name,
            });
          default:
            throw new Error("Invalid email type for speakers");
        }
      } else {
        switch (emailType) {
          case "confirmation":
            return emailTemplates.registrationConfirmation({
              attendeeName: recipient.name,
              eventName: event.name,
              eventDate,
              eventVenue,
              ticketType: recipient.ticketType || "General Admission",
              registrationId: recipient.id.slice(-8).toUpperCase(),
            });
          case "reminder":
            const daysUntil = event.startDate
              ? Math.ceil(
                  (new Date(event.startDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                )
              : 1;
            return emailTemplates.eventReminder({
              recipientName: recipient.name,
              eventName: event.name,
              eventDate,
              eventVenue,
              eventAddress: event.address || undefined,
              daysUntilEvent: Math.max(daysUntil, 1),
            });
          case "custom":
            if (!customSubject || !customMessage) {
              throw new Error("Custom emails require subject and message");
            }
            return emailTemplates.customNotification({
              recipientName: recipient.name,
              subject: customSubject,
              message: customMessage,
              eventName: event.name,
            });
          default:
            throw new Error("Invalid email type for registrations");
        }
      }
    };

    // Send emails in batches to avoid serverless timeout (Vercel 30s limit)
    const BATCH_SIZE = 25;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (recipient) => {
          try {
            const emailContent = generateEmailContent(recipient);
            const result = await sendEmail({
              to: [{ email: recipient.email, name: recipient.name }],
              subject: emailContent.subject,
              htmlContent: emailContent.htmlContent,
              textContent: emailContent.textContent,
              replyTo:
                (recipientType === "speakers" || recipientType === "reviewers") && organizerEmail
                  ? { email: organizerEmail, name: organizerName }
                  : undefined,
            });
            return { recipient, result };
          } catch (error) {
            apiLogger.error({ err: error, msg: "Failed to send email to recipient", email: recipient.email });
            return {
              recipient,
              result: { success: false, error: "Failed to send email" },
            };
          }
        })
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          const { recipient, result: emailResult } = result.value;
          if (emailResult.success) {
            successCount++;
          } else {
            failureCount++;
            errors.push({ email: recipient.email, error: emailResult.error || "Unknown error" });
          }
        } else {
          failureCount++;
        }
      }
    }

    // Log the bulk action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "BULK_EMAIL_SENT",
        entityType: recipientType === "speakers" ? "Speaker" : recipientType === "reviewers" ? "Reviewer" : "Registration",
        entityId: eventId,
        changes: {
          emailType,
          totalRecipients: recipients.length,
          successCount,
          failureCount,
          customSubject,
          ip: getClientIp(req),
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
