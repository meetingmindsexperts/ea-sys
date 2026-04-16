import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

/**
 * DELETE — unassign a reviewer from a specific abstract.
 *
 * Preserves any existing submission from this reviewer (their row gets
 * `abstractReviewerId = null` via SET NULL FK cascade). The scores and
 * notes they already contributed are valuable independent of the
 * assignment metadata.
 */

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string; userId: string }>;
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId, userId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const [event, abstract, assignment] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
      db.abstractReviewer.findUnique({
        where: { abstractId_userId: { abstractId, userId } },
        select: { id: true },
      }),
    ]);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    if (!assignment) {
      return NextResponse.json(
        { error: "Assignment not found", code: "ASSIGNMENT_NOT_FOUND" },
        { status: 404 },
      );
    }

    await db.abstractReviewer.delete({ where: { id: assignment.id } });

    apiLogger.info(
      { msg: "abstract-reviewer:unassigned", eventId, abstractId, reviewerUserId: userId },
    );

    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "UNASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "api", abstractId, reviewerUserId: userId, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, eventId, abstractId }, "unassign-reviewer:audit-log-failed"));

    return NextResponse.json({
      success: true,
      unassignedAssignmentId: assignment.id,
      note: "Assignment removed. Any submission this reviewer made is preserved.",
    });
  } catch (err) {
    apiLogger.error({ err, msg: "unassign-reviewer:failed" });
    return NextResponse.json(
      {
        error: "Failed to unassign reviewer",
        code: "UNASSIGN_REVIEWER_FAILED",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
