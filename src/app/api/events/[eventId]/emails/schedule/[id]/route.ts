import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

const MIN_LEAD_MS = 5 * 60 * 1000;

// NOTE: `filters` is deliberately NOT editable here (review M3). This PATCH
// REPLACES the whole filters JSON, and a partial `{status, ticketTypeId}`
// schema would silently strip the send-critical keys that ride inside filters
// (templateSlug / certificateTemplateIds / surveyExpiryDays / multi-value
// paymentStatus / ticketTypeIds / badgeTypes / tagsInclude) — turning a
// template/cert/survey send into a fire-time FAIL or a silent audience-widen.
// The edit dialog only changes subject/message/time; to change the audience,
// cancel and create a new scheduled send. Any `filters` in the body is ignored
// (Zod strips unknown keys), so the persisted filters are left untouched.
const updateSchema = z.object({
  customSubject: z.string().max(500).nullable().optional(),
  customMessage: z.string().max(10000).nullable().optional(),
  scheduledFor: z.coerce.date().optional(),
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
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

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
        organizationId: orgGuard.orgId,
        status: "PENDING",
      },
      data: {
        ...(data.customSubject !== undefined ? { customSubject: data.customSubject } : {}),
        ...(data.customMessage !== undefined ? { customMessage: data.customMessage } : {}),
        ...(data.scheduledFor ? { scheduledFor: data.scheduledFor } : {}),
        ...(data.attachments !== undefined ? { attachments: data.attachments ?? undefined } : {}),
      },
    });

    if (updateResult.count === 0) {
      // Either the row doesn't exist, doesn't belong to this org, or has
      // already been claimed by the cron / cancelled / sent.
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, organizationId: orgGuard.orgId },
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
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Atomic cancel. PENDING rows cancel outright. PROCESSING rows can now be
    // cancelled too (review C5, July 16 2026): the sender re-checks
    // status+claimToken between 25-recipient batches and stops at the next
    // boundary — before this, a mistaken 2,000-recipient send had NO stop
    // lever once the worker claimed it. Already-sent emails are not recalled;
    // emailedKeys keeps what went out, so a later Retry would resume, not
    // re-send.
    const result = await db.scheduledEmail.updateMany({
      where: {
        id,
        eventId,
        organizationId: orgGuard.orgId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "CANCELLED" },
    });

    if (result.count === 0) {
      const existing = await db.scheduledEmail.findFirst({
        where: { id, eventId, organizationId: orgGuard.orgId },
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
