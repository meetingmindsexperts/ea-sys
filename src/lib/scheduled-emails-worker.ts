/**
 * Scheduled-emails worker — drains ScheduledEmail PENDING rows on a cron
 * cadence, dispatches each via `executeBulkEmail`, and tracks success/
 * failure counts so the operator can retry failed rows from the
 * Communications page.
 *
 * Extracted from `/api/cron/scheduled-emails/route.ts` as part of the
 * Phase 1 worker-extraction refactor (see
 * docs/WORKER_EXTRACTION_PLAN.md). The route handler is now a thin
 * shim that runs the auth check and calls `runScheduledEmailsTick()`;
 * during the dual-write window (Phase 2-3) the same function is also
 * invoked by the node-cron scheduler inside the worker process. The
 * underlying behavior is unchanged from the previous all-in-the-route
 * implementation.
 *
 * Why the shape moved BUT the logic did not:
 *   - `processRow` still owns the PENDING→PROCESSING claim + the
 *     try/catch around send + the SENT/FAILED status flip
 *   - the tick-level stuck-row sweep, batch organizer lookup, and
 *     parallel row dispatch all live in `runScheduledEmailsTick`
 *   - the HTTP envelope (auth check + NextResponse shape) is the
 *     ONLY thing that stayed in the route
 *
 * Concurrency / idempotency guarantees stay the same:
 *   - claim flips PENDING→PROCESSING atomically (updateMany with
 *     status filter); two callers can race the same row safely
 *   - stuck sweep flips PROCESSING→FAILED after 10 min so crashed
 *     mid-send rows surface to the operator for manual retry
 *   - the entire tick is wrapped in apiLogger calls — every failure
 *     path logs, never silent (matches the "every failure logs" rule)
 */

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { notifyEventAdmins } from "@/lib/notifications";
import {
  executeBulkEmail,
  type BulkEmailRecipientType,
  type BulkEmailType,
  type BulkEmailAttachment,
  type BulkEmailFilters,
} from "@/lib/bulk-email";

// How many due rows to process per cron tick. Each row may dispatch hundreds of
// emails in serial batches of 25, so keep this small to stay under the route
// timeout (~60s on Vercel; longer on EC2 but the Next.js process is busy).
export const MAX_PER_TICK = 10;

// Rows stuck in PROCESSING for longer than this are assumed to have crashed
// mid-send (server restart, Lambda eviction, segfault) and are flipped to
// FAILED so the user can manually retry. 10 minutes is well above the longest
// realistic single-row send time.
export const STUCK_PROCESSING_MS = 10 * 60 * 1000;

export interface TickResult {
  id: string;
  status: "sent" | "failed" | "skipped";
  total?: number;
  sent?: number;
  failed?: number;
  error?: string;
}

export interface ScheduledEmailsTickReport {
  processed: number;
  sent: number;
  failed: number;
  swept: number;
  results: TickResult[];
  durationMs: number;
}

async function processRow(
  row: {
    id: string;
    eventId: string;
    organizationId: string;
    createdById: string;
    recipientType: string;
    emailType: string;
    customSubject: string | null;
    customMessage: string | null;
    attachments: unknown;
    filters: unknown;
    recipientIds: string[];
    retryCount: number;
  },
  organizer:
    | { firstName: string; lastName: string; email: string; emailSignature: string | null }
    | null,
): Promise<TickResult> {
  // Atomic claim — only proceed if we flipped PENDING→PROCESSING.
  const claim = await db.scheduledEmail.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claim.count === 0) {
    return { id: row.id, status: "skipped" };
  }

  try {
    const result = await executeBulkEmail({
      eventId: row.eventId,
      recipientType: row.recipientType as BulkEmailRecipientType,
      // Empty array = filter-based send; executeBulkEmail keys off
      // recipientIds?.length, so pass undefined when none were selected.
      recipientIds: row.recipientIds.length ? row.recipientIds : undefined,
      emailType: row.emailType as BulkEmailType,
      customSubject: row.customSubject ?? undefined,
      customMessage: row.customMessage ?? undefined,
      attachments: (row.attachments as BulkEmailAttachment[] | null) ?? undefined,
      filters: (row.filters as BulkEmailFilters | null) ?? undefined,
      organizerName:
        organizer?.firstName && organizer?.lastName
          ? `${organizer.firstName} ${organizer.lastName}`
          : "Event Organizer",
      organizerEmail: organizer?.email ?? "",
      organizerSignature: organizer?.emailSignature ?? undefined,
      organizationId: row.organizationId,
      triggeredByUserId: row.createdById,
    });

    await db.scheduledEmail.update({
      where: { id: row.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        totalCount: result.total,
        successCount: result.successCount,
        failureCount: result.failureCount,
        lastError: result.errors.length ? JSON.stringify(result.errors.slice(0, 5)) : null,
      },
    });

    // Fire-and-forget — do not block the cron tick on audit / notification writes.
    db.auditLog
      .create({
        data: {
          eventId: row.eventId,
          userId: row.createdById,
          action: "SCHEDULED_EMAIL_SENT",
          entityType: "ScheduledEmail",
          entityId: row.id,
          changes: {
            source: "cron",
            totalRecipients: result.total,
            successCount: result.successCount,
            failureCount: result.failureCount,
          },
        },
      })
      .catch((err) =>
        apiLogger.error({ err, msg: "Failed to write SCHEDULED_EMAIL_SENT audit log", id: row.id }),
      );

    notifyEventAdmins(row.eventId, {
      type: "REGISTRATION",
      title: "Scheduled Email Sent",
      message: `Email sent to ${result.successCount} recipients`,
      link: `/events/${row.eventId}/communications`,
    }).catch((err) =>
      apiLogger.error({ err, msg: "Failed to notify admins of scheduled email send", id: row.id }),
    );

    apiLogger.info({
      msg: "scheduled-email:sent",
      id: row.id,
      eventId: row.eventId,
      retryCount: row.retryCount,
      total: result.total,
      successCount: result.successCount,
      failureCount: result.failureCount,
    });

    return {
      id: row.id,
      status: "sent",
      total: result.total,
      sent: result.successCount,
      failed: result.failureCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await db.scheduledEmail.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        sentAt: new Date(),
        lastError: message,
      },
    });
    apiLogger.error({
      err,
      msg: "scheduled-email:send-failed",
      id: row.id,
      eventId: row.eventId,
      retryCount: row.retryCount,
    });
    return { id: row.id, status: "failed", error: message };
  }
}

/**
 * One scheduled-emails cron tick. Pure async function — no HTTP, no
 * auth, no NextResponse. Callable from either the legacy route shim or
 * the future node-cron worker process.
 */
export async function runScheduledEmailsTick(): Promise<ScheduledEmailsTickReport> {
  const startedAt = Date.now();
  apiLogger.debug({ msg: "scheduled-emails:tick-start" });

  // Sweep stuck PROCESSING rows back to FAILED so users can retry them.
  const stuckCutoff = new Date(Date.now() - STUCK_PROCESSING_MS);
  const swept = await db.scheduledEmail.updateMany({
    where: { status: "PROCESSING", updatedAt: { lt: stuckCutoff } },
    data: {
      status: "FAILED",
      lastError:
        "Stuck in processing for >10 min — likely crashed mid-send. Use Retry to re-queue.",
    },
  });
  if (swept.count > 0) {
    apiLogger.warn({ msg: "scheduled-emails:swept-stuck-rows", count: swept.count });
  }

  // Find due rows.
  const due = await db.scheduledEmail.findMany({
    where: { status: "PENDING", scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: "asc" },
    take: MAX_PER_TICK,
    select: {
      id: true,
      eventId: true,
      organizationId: true,
      createdById: true,
      recipientType: true,
      emailType: true,
      customSubject: true,
      customMessage: true,
      attachments: true,
      filters: true,
      recipientIds: true,
      retryCount: true,
    },
  });

  if (due.length === 0) {
    const durationMs = Date.now() - startedAt;
    apiLogger.debug({
      msg: "scheduled-emails:tick-complete",
      processed: 0,
      durationMs,
    });
    return { processed: 0, sent: 0, failed: 0, swept: swept.count, results: [], durationMs };
  }

  // Batch organizer lookup — many rows often share the same creator.
  const organizerIds = [...new Set(due.map((r) => r.createdById))];
  const organizers = await db.user.findMany({
    where: { id: { in: organizerIds } },
    select: { id: true, firstName: true, lastName: true, email: true, emailSignature: true },
  });
  const organizerMap = new Map(organizers.map((u) => [u.id, u]));

  // Process rows in parallel. Each row's send is itself batched serially
  // inside executeBulkEmail, so the concurrency stays bounded.
  const settled = await Promise.allSettled(
    due.map((row) => processRow(row, organizerMap.get(row.createdById) ?? null)),
  );

  const results: TickResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    apiLogger.error({
      err: s.reason,
      msg: "scheduled-email:row-promise-rejected",
      id: due[i].id,
    });
    return { id: due[i].id, status: "failed", error: "Row promise rejected" };
  });

  const sentCount = results.filter((r) => r.status === "sent").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const durationMs = Date.now() - startedAt;

  apiLogger.info({
    msg: "scheduled-emails:tick-complete",
    processed: results.length,
    sent: sentCount,
    failed: failedCount,
    swept: swept.count,
    durationMs,
  });

  return {
    processed: results.length,
    sent: sentCount,
    failed: failedCount,
    swept: swept.count,
    results,
    durationMs,
  };
}
