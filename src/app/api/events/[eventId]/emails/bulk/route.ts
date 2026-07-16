import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit, getClientIp } from "@/lib/security";
import {
  bulkEmailSchema,
  precheckBulkEmailViability,
  findDuplicateQueuedSend,
  BulkEmailError,
} from "@/lib/bulk-email";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * Immediate bulk send.
 *
 * As of 2026-06-09 this no longer sends inline. It enqueues a
 * `ScheduledEmail` row with `scheduledFor = now` and returns a job id
 * (202). The scheduled-emails worker (runs every minute) drains it via
 * the SAME `executeBulkEmail` the scheduled path uses, so the HTTP
 * request can never block on / time out against a large fan-out, and the
 * caller polls status via the existing Scheduled Emails list. "Send now"
 * therefore means "sends within ~60s". Explicitly-selected recipients are
 * preserved through `recipientIds` on the row; the worker also emits the
 * "Scheduled Email Sent" admin notification on completion.
 */
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

    // Shared bucket with the scheduled-send route — 20/hr per event.
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

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // M2: validate send viability SYNCHRONOUSLY here (same checks the worker
    // runs at fire time) so a misconfigured send — untagged cert template,
    // missing agreement template, deactivated custom slug, unbuilt survey —
    // returns a real 4xx now instead of a green "queued" toast followed by a
    // FAILED ScheduledEmail row a minute later.
    try {
      await precheckBulkEmailViability({
        eventId,
        recipientType,
        emailType,
        customSubject,
        customMessage,
        attachments,
        filters,
      });
    } catch (err) {
      if (err instanceof BulkEmailError) {
        apiLogger.warn({
          msg: "bulk-email:precheck-failed",
          eventId,
          userId: session.user.id,
          emailType,
          code: err.code,
          reason: err.message,
        });
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    // H2: idempotency guard against a double-click / HTTP-retry of this
    // non-idempotent enqueue. Without it, two identical "send now" POSTs create
    // two ScheduledEmail rows and the worker drains BOTH → the whole audience
    // is emailed twice (the 20/hr limit is no defense — both fit under it).
    // Shared with the schedule POST (review C3) — one guard, two enqueue doors.
    const duplicate = await findDuplicateQueuedSend({
      eventId,
      createdById: session.user.id,
      recipientType,
      emailType,
      customSubject,
      customMessage,
      recipientIds,
      filters,
      scheduledFor: null, // send-now mode
    });
    if (duplicate) {
      apiLogger.info({
        msg: "bulk-email:dedup-hit",
        eventId,
        jobId: duplicate.id,
        userId: session.user.id,
        emailType,
      });
      return NextResponse.json(
        {
          success: true,
          queued: true,
          deduplicated: true,
          jobId: duplicate.id,
          status: "PENDING",
          message: "This send was already queued moments ago — it will go out within about a minute.",
        },
        { status: 202 },
      );
    }

    // Enqueue for immediate processing — scheduledFor = now, so the
    // scheduled-emails worker claims it on its next tick (≤60s). The
    // worker reconstructs the organizer (name + signature) from
    // createdById, so we don't need to load the user here.
    const created = await db.scheduledEmail.create({
      data: {
        eventId,
        organizationId: session.user.organizationId!,
        createdById: session.user.id,
        recipientType,
        recipientIds: recipientIds ?? [],
        emailType,
        customSubject,
        customMessage,
        attachments: attachments ?? undefined,
        filters: filters ?? undefined,
        scheduledFor: new Date(),
      },
      select: { id: true, status: true },
    });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "BULK_EMAIL_QUEUED",
          entityType: "ScheduledEmail",
          entityId: created.id,
          changes: {
            emailType,
            recipientType,
            selectedRecipientCount: recipientIds?.length ?? 0,
            customSubject,
            hasAttachments:
              !!attachments?.length ||
              (emailType === "agreement" && recipientType === "speakers"),
            ip: getClientIp(req),
          },
        },
      })
      .catch((err: unknown) =>
        apiLogger.error({ err, msg: "Failed to write BULK_EMAIL_QUEUED audit log", id: created.id })
      );

    apiLogger.info({
      msg: "bulk-email:queued",
      eventId,
      jobId: created.id,
      recipientType,
      emailType,
      selectedRecipientCount: recipientIds?.length ?? 0,
    });

    return NextResponse.json(
      {
        success: true,
        queued: true,
        jobId: created.id,
        status: created.status,
        message:
          "Email queued — it will be sent within about a minute. Track progress under Scheduled Emails.",
      },
      { status: 202 }
    );
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error queueing bulk emails" });
    return NextResponse.json({ error: "Failed to queue bulk emails" }, { status: 500 });
  }
}
