import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";
import { bulkEmailSchema, executeBulkEmail, BulkEmailError } from "@/lib/bulk-email";

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
      apiLogger.warn({
        msg: "bulk-email:rate-limited",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Bulk email limit reached. Maximum 20 sends per event per hour." },
        { status: 429, headers: { "Retry-After": String(bulkEmailRateLimit.retryAfterSeconds) } }
      );
    }

    const validated = bulkEmailSchema.safeParse(body);

    if (!validated.success) {
      apiLogger.warn({
        msg: "bulk-email:validation-failed",
        eventId,
        errors: validated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { recipientType, recipientIds, emailType, customSubject, customMessage, attachments, filters } =
      validated.data;

    const [event, user] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.user.findUnique({
        where: { id: session.user.id },
        select: { firstName: true, lastName: true, email: true, emailSignature: true },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const organizerName = user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}` : "Event Organizer";
    const organizerEmail = user?.email || "";
    const organizerSignature = user?.emailSignature ?? undefined;

    let result;
    try {
      result = await executeBulkEmail({
        eventId,
        recipientType,
        recipientIds,
        emailType,
        customSubject,
        customMessage,
        attachments,
        filters,
        organizerName,
        organizerEmail,
        organizerSignature,
        organizationId: session.user.organizationId ?? null,
        triggeredByUserId: session.user.id,
      });
    } catch (err) {
      if (err instanceof BulkEmailError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "BULK_EMAIL_SENT",
          entityType:
            recipientType === "speakers"
              ? "Speaker"
              : recipientType === "reviewers"
              ? "Reviewer"
              : "Registration",
          entityId: eventId,
          changes: {
            emailType,
            totalRecipients: result.total,
            successCount: result.successCount,
            failureCount: result.failureCount,
            customSubject,
            hasAttachments:
              !!attachments?.length ||
              (emailType === "agreement" && recipientType === "speakers"),
            ip: getClientIp(req),
          },
        },
      })
      .catch((err: unknown) =>
        apiLogger.error({ err, msg: "Failed to write BULK_EMAIL_SENT audit log" })
      );

    notifyEventAdmins(eventId, {
      type: "REGISTRATION",
      title: "Bulk Email Sent",
      message: `Email sent to ${result.successCount} recipients`,
      link: `/events/${eventId}/registrations`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send bulk email notification" }));

    return NextResponse.json({
      success: true,
      message: `Sent ${result.successCount} of ${result.total} emails`,
      stats: { total: result.total, sent: result.successCount, failed: result.failureCount },
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error sending bulk emails" });
    return NextResponse.json({ error: "Failed to send bulk emails" }, { status: 500 });
  }
}
