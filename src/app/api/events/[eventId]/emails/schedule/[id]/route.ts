import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

const MIN_LEAD_MS = 5 * 60 * 1000;

const updateSchema = z.object({
  customSubject: z.string().max(500).nullable().optional(),
  customMessage: z.string().max(10000).nullable().optional(),
  scheduledFor: z.coerce.date().optional(),
  filters: z
    .object({
      status: z.string().max(50).optional(),
      ticketTypeId: z.string().max(100).optional(),
    })
    .nullable()
    .optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().max(255),
        content: z.string(),
        contentType: z.string().max(100).optional(),
      })
    )
    .max(5)
    .nullable()
    .optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; id: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, id }, session, body] = await Promise.all([
      params,
      auth(),
      req.json(),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const validated = updateSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({
        msg: "scheduled-email:patch-validation-failed",
        id,
        errors: validated.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    if (data.scheduledFor && data.scheduledFor.getTime() < Date.now() + MIN_LEAD_MS) {
      return NextResponse.json(
        { error: "Scheduled time must be at least 5 minutes in the future" },
        { status: 400 }
      );
    }

    // Atomic conditional update — only mutate if still PENDING. This races
    // safely against the cron worker which atomically claims rows by flipping
    // PENDING → PROCESSING.
    const updateResult = await db.scheduledEmail.updateMany({
      where: {
        id,
        eventId,
        organizationId: session.user.organizationId!,
        status: "PENDING",
      },
      data: {
        ...(data.customSubject !== undefined ? { customSubject: data.customSubject } : {}),
        ...(data.customMessage !== undefined ? { customMessage: data.customMessage } : {}),
        ...(data.scheduledFor ? { scheduledFor: data.scheduledFor } : {}),
        ...(data.filters !== undefined ? { filters: data.filters ?? undefined } : {}),
        ...(data.attachments !== undefined ? { attachments: data.attachments ?? undefined } : {}),
      },
    });

    if (updateResult.count === 0) {
      // Either the row doesn't exist, doesn't belong to this org, or has
      // already been claimed by the cron / cancelled / sent.
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, organizationId: session.user.organizationId! },
        select: { status: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Scheduled email not found" }, { status: 404 });
      }
      apiLogger.warn({
        msg: "scheduled-email:edit-race-lost",
        id,
        status: existing.status,
      });
      return NextResponse.json(
        { error: `Cannot edit a scheduled email with status ${existing.status}` },
        { status: 409 }
      );
    }

    const updated = await db.scheduledEmail.findUnique({ where: { id } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SCHEDULED_EMAIL_UPDATED",
          entityType: "ScheduledEmail",
          entityId: id,
          changes: { fields: Object.keys(data), ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_UPDATED audit log", id })
      );

    return NextResponse.json({ success: true, scheduledEmail: updated });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating scheduled email" });
    return NextResponse.json({ error: "Failed to update scheduled email" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, id }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Atomic cancel — only succeeds if the row is still PENDING.
    const result = await db.scheduledEmail.updateMany({
      where: {
        id,
        eventId,
        organizationId: session.user.organizationId!,
        status: "PENDING",
      },
      data: { status: "CANCELLED" },
    });

    if (result.count === 0) {
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, organizationId: session.user.organizationId! },
        select: { status: true },
      });
      if (!existing) {
        return NextResponse.json({ error: "Scheduled email not found" }, { status: 404 });
      }
      apiLogger.warn({
        msg: "scheduled-email:cancel-race-lost",
        id,
        status: existing.status,
      });
      return NextResponse.json(
        { error: `Cannot cancel a scheduled email with status ${existing.status}` },
        { status: 409 }
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "SCHEDULED_EMAIL_CANCELLED",
          entityType: "ScheduledEmail",
          entityId: id,
          changes: { ip: getClientIp(req) },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_CANCELLED audit log", id })
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error cancelling scheduled email" });
    return NextResponse.json({ error: "Failed to cancel scheduled email" }, { status: 500 });
  }
}
