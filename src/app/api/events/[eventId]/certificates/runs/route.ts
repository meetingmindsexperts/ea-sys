/**
 * GET /api/events/[eventId]/certificates/runs?status=active|all
 *
 * Lists certificate-issue runs for the event. Operator UI uses this to
 * resume runs that are mid-state (AWAITING_REVIEW especially) after a
 * page refresh — without this, in-progress runs disappear from the
 * dashboard once the original tab's React state is lost.
 *
 *   status=active (default) → PENDING / RENDERING / AWAITING_REVIEW / SENDING
 *   status=all               → every status including COMPLETED / FAILED / CANCELLED
 *
 * Scope: ADMIN / ORGANIZER (denyReviewer). Org-bound via the event.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import type { CertIssueRunStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const ACTIVE_STATUSES: CertIssueRunStatus[] = [
  "PENDING",
  "RENDERING",
  "AWAITING_REVIEW",
  "SENDING",
];

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-runs-list:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Bind event to org before listing — same pattern as the templates
    // route. Returns 404 (not 403) for cross-tenant to avoid enumeration.
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "cert-runs-list:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? "active";
    const where =
      statusParam === "all"
        ? { eventId }
        : { eventId, status: { in: ACTIVE_STATUSES } };

    const runs = await db.certificateIssueRun.findMany({
      where,
      orderBy: { triggeredAt: "desc" },
      take: 50, // cap; an event rarely has more active runs than this
      select: {
        id: true,
        type: true,
        status: true,
        totalCount: true,
        renderedCount: true,
        emailedCount: true,
        failedCount: true,
        triggeredAt: true,
        rendererFinishedAt: true,
        emailerFinishedAt: true,
        lastTickAt: true,
        certificateTemplate: { select: { id: true, name: true } },
        // Bundle-model runs (2+ templates) leave certificateTemplateId null
        // and list their templates here — the UI joins names client-side.
        templateIds: true,
      },
    });

    return NextResponse.json({ runs });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-runs-list:failed" });
    return NextResponse.json({ error: "Failed to load runs" }, { status: 500 });
  }
}
