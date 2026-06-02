/**
 * POST /api/events/[eventId]/certificates/runs/[runId]/send
 *
 * Transitions a run from AWAITING_REVIEW → SENDING. This is the
 * operator's "I've reviewed the rendered PDFs and approve the emails"
 * confirmation gate.
 *
 * The cron worker picks SENDING runs up next tick and drains the email
 * phase. Returns the updated run state for the UI to render.
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
  let runId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    runId = p.runId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Atomic transition — only AWAITING_REVIEW runs can move to SENDING.
    // updateMany with the status guard prevents double-click race.
    const updated = await db.certificateIssueRun.updateMany({
      where: {
        id: runId,
        status: "AWAITING_REVIEW",
        event: { organizationId: session.user.organizationId, id: p.eventId },
      },
      data: {
        status: "SENDING",
        emailerStartedAt: new Date(),
        lastTickAt: new Date(),
      },
    });
    if (updated.count === 0) {
      const run = await db.certificateIssueRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (!run) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      return NextResponse.json(
        {
          error: `Cannot send — run is in status ${run.status}. Only AWAITING_REVIEW runs can be sent.`,
          code: "INVALID_TRANSITION",
          currentStatus: run.status,
        },
        { status: 409 },
      );
    }

    db.auditLog
      .create({
        data: {
          eventId: p.eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "CertificateIssueRun",
          entityId: runId,
          changes: { transition: "AWAITING_REVIEW → SENDING", source: "dashboard" },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-run-send:audit-failed" }));

    apiLogger.info({
      msg: "cert-run-send:approved",
      runId,
      userId: session.user.id,
    });
    return NextResponse.json({ ok: true, status: "SENDING" });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-run-send:failed", runId });
    return NextResponse.json({ error: "Failed to start send phase" }, { status: 500 });
  }
}
