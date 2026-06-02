/**
 * GET /api/events/[eventId]/certificates/runs/[runId]
 *
 * Polling endpoint for the operator UI's progress bar. Returns the run
 * state + per-item progress sample so the UI can show:
 *   "Issued 1,247 / 2,000 (62%) — 11 failed"
 *
 * Returns the same shape regardless of run status so the polling JS
 * doesn't need to switch.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ eventId: string; runId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, runId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const run = await db.certificateIssueRun.findFirst({
      where: {
        id: runId,
        event: { organizationId: session.user.organizationId, id: eventId },
      },
      select: {
        id: true, eventId: true, type: true, status: true,
        totalCount: true, renderedCount: true, emailedCount: true, failedCount: true,
        triggeredAt: true,
        rendererStartedAt: true, rendererFinishedAt: true,
        emailerStartedAt: true, emailerFinishedAt: true,
        lastTickAt: true, errors: true,
        triggeredBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    // Sample recipients for the operator preview — the first 20 items
    // with their progress state. Joined with IssuedCertificate so the
    // UI can offer a 'View rendered PDF' link at AWAITING_REVIEW (the
    // human-review gate exists precisely to spot-check the PDFs before
    // emails fan out; without surfacing pdfUrl + serial here the
    // operator would have to dig through the filesystem). Capped at 20
    // so the polling response stays small even on multi-thousand
    // recipient runs.
    const sampleItemsRaw = await db.certificateIssueRunItem.findMany({
      where: { runId },
      orderBy: { recipientName: "asc" },
      take: 20,
      select: {
        id: true, recipientName: true, recipientEmail: true,
        renderedAt: true, emailedAt: true,
        errorPhase: true, errorMessage: true,
        issuedCertificateId: true,
        issuedCertificate: { select: { pdfUrl: true, serial: true } },
      },
    });
    const sampleItems = sampleItemsRaw.map((r) => ({
      id: r.id,
      recipientName: r.recipientName,
      recipientEmail: r.recipientEmail,
      renderedAt: r.renderedAt,
      emailedAt: r.emailedAt,
      errorPhase: r.errorPhase,
      errorMessage: r.errorMessage,
      issuedCertificateId: r.issuedCertificateId,
      // Surface the rendered PDF URL + serial at the top level for the
      // UI. Null until the item completes the RENDER phase.
      pdfUrl: r.issuedCertificate?.pdfUrl ?? null,
      serial: r.issuedCertificate?.serial ?? null,
    }));

    // ALL failed items (not just the sample). The operator needs the
    // full failures list to decide whether to retry or accept the
    // partial run. Bounded by `failedCount` on the run row, which is
    // capped operationally by the recipient pool — for events with
    // tens of thousands of recipients the worst case is a few hundred
    // failures, which fits comfortably in a polling response.
    const failedItems =
      run.failedCount > 0
        ? await db.certificateIssueRunItem.findMany({
            where: { runId, errorMessage: { not: null } },
            orderBy: { recipientName: "asc" },
            select: {
              id: true,
              recipientName: true,
              recipientEmail: true,
              errorPhase: true,
              errorMessage: true,
              renderedAt: true,
              emailedAt: true,
              issuedCertificateId: true,
            },
          })
        : [];

    return NextResponse.json({
      runId: run.id,
      eventId: run.eventId,
      type: run.type,
      status: run.status,
      totalCount: run.totalCount,
      renderedCount: run.renderedCount,
      emailedCount: run.emailedCount,
      failedCount: run.failedCount,
      progressPct: run.totalCount === 0
        ? 0
        : Math.round(((run.renderedCount + run.emailedCount) / (run.totalCount * 2)) * 100),
      triggeredAt: run.triggeredAt,
      triggeredBy: run.triggeredBy,
      rendererStartedAt: run.rendererStartedAt,
      rendererFinishedAt: run.rendererFinishedAt,
      emailerStartedAt: run.emailerStartedAt,
      emailerFinishedAt: run.emailerFinishedAt,
      lastTickAt: run.lastTickAt,
      errors: run.errors,
      sampleItems,
      failedItems,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-run-poll:failed" });
    return NextResponse.json({ error: "Failed to load run" }, { status: 500 });
  }
}
