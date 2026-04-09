import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { bulkEmailSchema } from "@/lib/bulk-email";

const MIN_LEAD_MS = 5 * 60 * 1000; // 5 minutes

const scheduleSchema = bulkEmailSchema.extend({
  scheduledFor: z.coerce.date(),
});

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

    // Share the same rate limit bucket as immediate sends — 20/hr per event
    const rateLimit = checkRateLimit({
      key: `bulk-email:org:${session.user.organizationId}:event:${eventId}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });

    if (!rateLimit.allowed) {
      apiLogger.warn({
        msg: "scheduled-email:rate-limited",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Bulk email limit reached. Maximum 20 sends per event per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const validated = scheduleSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({
        msg: "scheduled-email:create-validation-failed",
        eventId,
        errors: validated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    if (data.scheduledFor.getTime() < Date.now() + MIN_LEAD_MS) {
      return NextResponse.json(
        { error: "Scheduled time must be at least 5 minutes in the future" },
        { status: 400 }
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const created = await db.scheduledEmail.create({
      data: {
        eventId,
        organizationId: session.user.organizationId!,
        createdById: session.user.id,
        recipientType: data.recipientType,
        emailType: data.emailType,
        customSubject: data.customSubject,
        customMessage: data.customMessage,
        attachments: data.attachments ?? undefined,
        filters: data.filters ?? undefined,
        scheduledFor: data.scheduledFor,
      },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SCHEDULED_EMAIL_CREATED",
          entityType: "ScheduledEmail",
          entityId: created.id,
          changes: {
            recipientType: data.recipientType,
            emailType: data.emailType,
            scheduledFor: data.scheduledFor.toISOString(),
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_CREATED audit log", id: created.id })
      );

    return NextResponse.json({ success: true, scheduledEmail: created });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating scheduled email" });
    return NextResponse.json({ error: "Failed to schedule email" }, { status: 500 });
  }
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const scheduledEmails = await db.scheduledEmail.findMany({
      where: { eventId },
      orderBy: { scheduledFor: "desc" },
      select: {
        id: true,
        recipientType: true,
        emailType: true,
        customSubject: true,
        customMessage: true,
        filters: true,
        scheduledFor: true,
        status: true,
        sentAt: true,
        successCount: true,
        failureCount: true,
        totalCount: true,
        lastError: true,
        retryCount: true,
        createdAt: true,
        createdBy: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    return NextResponse.json({ scheduledEmails });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error listing scheduled emails" });
    return NextResponse.json({ error: "Failed to list scheduled emails" }, { status: 500 });
  }
}
