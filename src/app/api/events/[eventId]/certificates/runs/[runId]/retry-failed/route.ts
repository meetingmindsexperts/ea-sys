/**
 * POST /api/events/[eventId]/certificates/runs/[runId]/retry-failed
 *
 * Resets all failed items on this run back to a re-tryable state and
 * bumps the run's status so the cron worker picks them up on the next
 * tick. Idempotent: zero-failed runs are a no-op + 200.
 *
 * What "retry" means per phase:
 *   - Render-failed items   (issuedCertificateId is null) → clears
 *     errorPhase, errorMessage, AND renderedAt. The render-phase
 *     query (`renderedAt: null`) will pick them up again. The
 *     renderer attempts a fresh render + INSERT IssuedCertificate.
 *   - Email-failed items    (issuedCertificateId is set)  → clears
 *     errorPhase, errorMessage, AND emailedAt. The send-phase query
 *     (`issuedCertificateId NOT NULL AND emailedAt: null`) will pick
 *     them up again. The cert PDF + serial are preserved; only the
 *     delivery is retried.
 *
 * Status transitions:
 *   - If any render-failed items exist → run.status = RENDERING
 *     (worker resumes render phase; after it drains, transitions to
 *     AWAITING_REVIEW → operator clicks Send again).
 *   - If only email-failed items exist → run.status = SENDING
 *     (worker resumes the email phase directly).
 *
 * `failedCount` decrements by the number of reset items. The historical
 * error entries in `run.errors` JSON are PRESERVED so the audit trail
 * remains intact ("this run had 3 failures, retried, all succeeded
 * second time" is fully recoverable from the data).
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Audit log entry written.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ eventId: string; runId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let runId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    runId = p.runId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-retry-failed:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Org-bound lookup. We need the current status to decide the
    // post-retry status transition.
    const run = await db.certificateIssueRun.findFirst({
      where: {
        id: runId,
        event: { organizationId: session.user.organizationId, id: eventId },
      },
      select: { id: true, status: true, failedCount: true },
    });
    if (!run) {
      apiLogger.warn({
        msg: "cert-retry-failed:run-not-found",
        eventId,
        userId: session.user.id,
        runId,
      });
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    // Idempotency: nothing to retry.
    if (run.failedCount === 0) {
      return NextResponse.json({
        ok: true,
        retried: 0,
        message: "No failed items to retry.",
      });
    }

    // Don't retry while the worker is mid-tick in a phase that could
    // race with our reset — let the operator wait for AWAITING_REVIEW,
    // COMPLETED, FAILED, or CANCELLED. PENDING is fine (cron hasn't
    // claimed it yet).
    const safeStatuses = ["PENDING", "AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"];
    if (!safeStatuses.includes(run.status)) {
      apiLogger.warn({
        msg: "cert-retry-failed:unsafe-status",
        eventId,
        userId: session.user.id,
        runId,
        currentStatus: run.status,
      });
      return NextResponse.json(
        {
          error: `Cannot retry while the run is ${run.status}. Wait for the current phase to finish.`,
          code: "RUN_BUSY",
          currentStatus: run.status,
        },
        { status: 409 },
      );
    }

    // Pull the failed items so we know how to reset each one. Split by
    // phase to decide the run status transition.
    const failed = await db.certificateIssueRunItem.findMany({
      where: { runId, errorMessage: { not: null } },
      select: { id: true, errorPhase: true, issuedCertificateId: true },
    });

    if (failed.length === 0) {
      // Run.failedCount was stale (concurrent retry?) — recompute and
      // sync but don't try to reset anything.
      apiLogger.warn({
        msg: "cert-retry-failed:failedCount-mismatch",
        eventId,
        userId: session.user.id,
        runId,
        failedCountOnRun: run.failedCount,
        failedItemsFound: 0,
      });
      await db.certificateIssueRun.update({
        where: { id: runId },
        data: { failedCount: 0 },
      });
      return NextResponse.json({
        ok: true,
        retried: 0,
        message: "No failed items found (counter was stale; reset to 0).",
      });
    }

    // Decides the post-retry status transition. If any render failures
    // exist, restart at RENDERING (run will transition naturally
    // through AWAITING_REVIEW). Otherwise jump straight to SENDING.
    const hasRenderFailures = failed.some((f) => f.errorPhase === "render");

    // Atomic batch reset. Render-failed items need renderedAt cleared
    // so the render-phase query re-picks them; email-failed items need
    // emailedAt cleared so the send-phase query re-picks them. Both
    // groups get errorPhase + errorMessage cleared.
    const renderFailedIds = failed
      .filter((f) => f.errorPhase === "render")
      .map((f) => f.id);
    const emailFailedIds = failed
      .filter((f) => f.errorPhase === "email")
      .map((f) => f.id);

    await db.$transaction(async (tx) => {
      if (renderFailedIds.length > 0) {
        await tx.certificateIssueRunItem.updateMany({
          where: { id: { in: renderFailedIds } },
          data: {
            errorPhase: null,
            errorMessage: null,
            renderedAt: null,
            // issuedCertificateId is already null on render failures; no-op.
          },
        });
      }
      if (emailFailedIds.length > 0) {
        await tx.certificateIssueRunItem.updateMany({
          where: { id: { in: emailFailedIds } },
          data: {
            errorPhase: null,
            errorMessage: null,
            emailedAt: null,
            // issuedCertificateId is preserved — cert + serial stay; only delivery retries.
          },
        });
      }

      // Status transition + counter reset. Bump back into the
      // appropriate phase so the cron picks the items up next tick.
      // If only email-failed items exist, jump straight to SENDING;
      // otherwise restart at RENDERING (which transitions naturally
      // through AWAITING_REVIEW once the render queue drains again).
      const nextStatus = hasRenderFailures ? "RENDERING" : "SENDING";

      await tx.certificateIssueRun.update({
        where: { id: runId },
        data: {
          status: nextStatus,
          failedCount: { decrement: failed.length },
          // Reset finish timestamps for the phases we're re-entering
          // so progressPct + status badges reflect the resumed work.
          ...(hasRenderFailures && { rendererFinishedAt: null }),
          emailerFinishedAt: null,
          lastTickAt: new Date(),
        },
      });
    });

    db.auditLog
      .create({
        data: {
          eventId: eventId!,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "CertificateIssueRun",
          entityId: runId!,
          changes: {
            domain: "certificate-retry-failed",
            source: "dashboard",
            renderFailedReset: renderFailedIds.length,
            emailFailedReset: emailFailedIds.length,
            previousStatus: run.status,
            nextStatus: hasRenderFailures ? "RENDERING" : "SENDING",
          },
        },
      })
      .catch((err) =>
        apiLogger.warn({ err, msg: "cert-retry-failed:audit-failed", eventId, runId }),
      );

    apiLogger.info({
      msg: "cert-retry-failed:done",
      eventId,
      userId: session.user.id,
      runId,
      retried: failed.length,
      renderFailedReset: renderFailedIds.length,
      emailFailedReset: emailFailedIds.length,
      previousStatus: run.status,
      nextStatus: hasRenderFailures ? "RENDERING" : "SENDING",
    });

    return NextResponse.json({
      ok: true,
      retried: failed.length,
      renderFailedReset: renderFailedIds.length,
      emailFailedReset: emailFailedIds.length,
      nextStatus: hasRenderFailures ? "RENDERING" : "SENDING",
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-retry-failed:failed", eventId, runId });
    return NextResponse.json({ error: "Failed to retry failed items" }, { status: 500 });
  }
}
