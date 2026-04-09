import { NextResponse } from "next/server";
import { z } from "zod";
import { RegistrationStatus, SpeakerStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, brandingFrom } from "@/lib/email";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";

const bulkEmailSchema = z.object({
  recipientType: z.enum(["speakers", "registrations", "reviewers", "abstracts"]),
  recipientIds: z.array(z.string().max(100)).optional(),
  emailType: z.enum(["invitation", "agreement", "confirmation", "reminder", "custom", "abstract-accepted", "abstract-rejected", "abstract-revision", "abstract-reminder"]),
  customSubject: z.string().max(500).optional(),
  customMessage: z.string().max(10000).optional(),
  attachments: z.array(z.object({
    name: z.string().max(255),
    content: z.string(), // Base64
    contentType: z.string().max(100).optional(),
  })).max(5).optional(),
  filters: z
    .object({
      status: z.string().max(50).optional(),
      ticketTypeId: z.string().max(100).optional(),
    })
    .optional(),
});
const speakerStatusSchema = z.nativeEnum(SpeakerStatus);
const registrationStatusSchema = z.nativeEnum(RegistrationStatus);

// Max total attachment size: 10MB
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
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

    const { recipientType, recipientIds, emailType, customSubject, customMessage, attachments, filters } =
      validated.data;

    // Validate attachment size
    if (attachments?.length) {
      const totalSize = attachments.reduce((sum, a) => sum + a.content.length, 0);
      if (totalSize > MAX_ATTACHMENT_SIZE) {
        return NextResponse.json(
          { error: "Total attachment size exceeds 10MB limit" },
          { status: 400 }
        );
      }
    }

    const [event, user] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
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
      ? `${user.firstName} ${user.lastName}` : "Event Organizer";
    const organizerEmail = user?.email || "";
    const eventDate = event.startDate
      ? new Date(event.startDate).toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })
      : "TBA";
    const eventVenue = event.venue || "TBA";

    let recipients: Array<{ id: string; email: string; firstName: string; lastName: string; ticketType?: string; serialId?: number | null }> = [];
    let successCount = 0;
    let failureCount = 0;
    const errors: Array<{ email: string; error: string }> = [];

    if (recipientType === "reviewers") {
      const reviewerUserIds = (event.settings as { reviewerUserIds?: string[] })?.reviewerUserIds ?? [];
      if (reviewerUserIds.length === 0) {
        return NextResponse.json({ error: "No reviewers assigned to this event" }, { status: 400 });
      }
      const reviewerUsers = await db.user.findMany({
        where: {
          id: { in: recipientIds?.length ? recipientIds.filter((id) => reviewerUserIds.includes(id)) : reviewerUserIds },
          role: "REVIEWER",
        },
        select: { id: true, email: true, firstName: true, lastName: true },
      });
      recipients = reviewerUsers.map((u) => ({
        id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName,
      }));
    } else if (recipientType === "speakers") {
      const parsedStatus = filters?.status ? speakerStatusSchema.safeParse(filters.status) : null;
      const status = parsedStatus?.success ? parsedStatus.data : undefined;
      const speakers = await db.speaker.findMany({
        where: {
          eventId,
          ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
          ...(status && { status }),
        },
      });
      recipients = speakers.map((s) => ({
        id: s.id, email: s.email, firstName: s.firstName, lastName: s.lastName,
      }));
    } else if (recipientType === "abstracts") {
      const abstracts = await db.abstract.findMany({
        where: {
          eventId,
          ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
          ...(filters?.status ? { status: filters.status as never } : {}),
        },
        include: { speaker: true },
      });
      // Deduplicate by speaker email
      const seen = new Set<string>();
      for (const a of abstracts) {
        if (!seen.has(a.speaker.email)) {
          seen.add(a.speaker.email);
          recipients.push({
            id: a.id,
            email: a.speaker.email,
            firstName: a.speaker.firstName,
            lastName: a.speaker.lastName,
          });
        }
      }
    } else {
      const parsedStatus = filters?.status ? registrationStatusSchema.safeParse(filters.status) : null;
      const status = parsedStatus?.success ? parsedStatus.data : undefined;
      const registrations = await db.registration.findMany({
        where: {
          eventId,
          ...(recipientIds?.length ? { id: { in: recipientIds } } : {}),
          ...(status && { status }),
          ...(filters?.ticketTypeId ? { ticketTypeId: filters.ticketTypeId } : {}),
        },
        include: { ticketType: true, attendee: true },
      });
      recipients = registrations.map((r) => ({
        id: r.id, email: r.attendee.email, firstName: r.attendee.firstName,
        lastName: r.attendee.lastName, ticketType: r.ticketType?.name,
        serialId: r.serialId,
      }));
    }

    if (recipients.length === 0) {
      return NextResponse.json({ error: "No recipients found matching the criteria" }, { status: 400 });
    }

    // Determine template slug
    const slugMap: Record<string, string> = {
      invitation: "speaker-invitation",
      agreement: "speaker-agreement",
      confirmation: "registration-confirmation",
      reminder: "event-reminder",
      custom: "custom-notification",
    };
    const templateSlug = slugMap[emailType];

    // Load template once for the batch
    const tpl = await getEventTemplate(eventId, templateSlug) || getDefaultTemplate(templateSlug);
    if (!tpl) {
      return NextResponse.json({ error: "Email template not found" }, { status: 500 });
    }

    // Pre-compute days until event for reminders
    const daysUntil = event.startDate
      ? Math.max(1, Math.ceil((new Date(event.startDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 1;

    const branding = tpl && "branding" in tpl ? tpl.branding : { eventName: event.name };

    const generateEmailForRecipient = (recipient: typeof recipients[0]) => {
      const vars: Record<string, string | number> = {
        firstName: recipient.firstName,
        lastName: recipient.lastName,
        eventName: event.name,
        eventDate,
        eventVenue,
        eventAddress: event.address || "",
        organizerName,
        organizerEmail,
        personalMessage: customMessage || "",
        ticketType: recipient.ticketType || "General Admission",
        registrationId: recipient.serialId != null
          ? String(recipient.serialId).padStart(3, "0")
          : recipient.id.slice(-8).toUpperCase(),
        daysUntilEvent: daysUntil,
      };

      if (emailType === "custom") {
        if (!customSubject || !customMessage) throw new Error("Custom emails require subject and message");
        vars.subject = customSubject;
        vars.message = customMessage;
      }

      return renderAndWrap(tpl, vars, branding);
    };

    // Send in batches of 25
    const BATCH_SIZE = 25;
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (recipient) => {
          try {
            const emailContent = generateEmailForRecipient(recipient);
            const result = await sendEmail({
              to: [{ email: recipient.email, name: `${recipient.firstName} ${recipient.lastName}` }],
              subject: emailContent.subject,
              htmlContent: emailContent.htmlContent,
              textContent: emailContent.textContent,
              attachments,
              from: brandingFrom(branding),
              replyTo:
                (recipientType === "speakers" || recipientType === "reviewers") && organizerEmail
                  ? { email: organizerEmail, name: organizerName }
                  : undefined,
            });
            return { recipient, result };
          } catch (error) {
            apiLogger.error({ err: error, msg: "Failed to send email to recipient", email: recipient.email });
            return { recipient, result: { success: false, error: "Failed to send email" } };
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
          hasAttachments: !!attachments?.length,
          ip: getClientIp(req),
        },
      },
    });

    // Notify admins of bulk email sent
    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Bulk Email Sent",
      message: `Email sent to ${successCount} recipients`,
      link: `/events/${eventId}/registrations`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send bulk email notification" }));

    return NextResponse.json({
      success: true,
      message: `Sent ${successCount} of ${recipients.length} emails`,
      stats: { total: recipients.length, sent: successCount, failed: failureCount },
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending bulk emails" });
    return NextResponse.json({ error: "Failed to send bulk emails" }, { status: 500 });
  }
}
