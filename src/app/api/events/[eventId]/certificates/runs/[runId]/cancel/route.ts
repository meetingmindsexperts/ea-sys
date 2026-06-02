/**
 * POST /api/events/[eventId]/certificates/runs/[runId]/cancel
 *
 * Transitions a non-terminal run to CANCELLED. Items already processed
 * (renderedAt / emailedAt set) keep their state — cancellation just
 * stops the cron from picking up the run for further work. No rollback.
 *
 * Used when an operator changes their mind or kicks off a wrong run.
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

    const updated = await db.certificateIssueRun.updateMany({
      where: {
        id: runId,
        status: { in: ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] },
        event: { organizationId: session.user.organizationId, id: eventId },
      },
      data: { status: "CANCELLED", lastTickAt: new Date() },
    });
    if (updated.count === 0) {
      return NextResponse.json(
        { error: "Run not found or already in a terminal state", code: "INVALID_TRANSITION" },
        { status: 409 },
      );
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "CertificateIssueRun",
          entityId: runId,
          changes: { transition: "→ CANCELLED", source: "dashboard" },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-run-cancel:audit-failed" }));

    apiLogger.info({ msg: "cert-run-cancel:done", runId, userId: session.user.id });
    return NextResponse.json({ ok: true, status: "CANCELLED" });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-run-cancel:failed" });
    return NextResponse.json({ error: "Failed to cancel run" }, { status: 500 });
  }
}
