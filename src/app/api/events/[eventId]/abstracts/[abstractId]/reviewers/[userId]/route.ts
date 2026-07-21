import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";
import { unassignReviewer, type UnassignReviewerErrorCode } from "@/services/abstract-service";

/**
 * DELETE — unassign a reviewer from a specific abstract.
 *
 * Preserves any existing submission from this reviewer (their row gets
 * `abstractReviewerId = null` via SET NULL FK cascade). The scores and
 * notes they already contributed are valuable independent of the
 * assignment metadata.
 *
 * Domain logic lives in abstract-service.unassignReviewer (shared with the
 * MCP unassign_reviewer_from_abstract tool).
 */

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string; userId: string }>;
}

const HTTP_STATUS_FOR_UNASSIGN: Record<UnassignReviewerErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  ABSTRACT_NOT_FOUND: 404,
  ASSIGNMENT_NOT_FOUND: 404,
  UNKNOWN: 500,
};

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId, userId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const result = await unassignReviewer({
      eventId,
      organizationId: session.user.organizationId!,
      abstractId,
      reviewerUserId: userId,
      actorUserId: session.user.id,
      source: "rest",
      ip: getClientIp(req),
    });

    if (!result.ok) {
      if (result.code === "UNKNOWN") {
        // Stable 500 contract (review M2) — same body the route always returned.
        return NextResponse.json(
          { error: "Failed to unassign reviewer", code: "UNASSIGN_REVIEWER_FAILED" },
          { status: 500 },
        );
      }
      const status = HTTP_STATUS_FOR_UNASSIGN[result.code] ?? 500;
      const payload =
        result.code === "ASSIGNMENT_NOT_FOUND"
          ? { error: result.message, code: result.code }
          : { error: result.message };
      return NextResponse.json(payload, { status });
    }

    return NextResponse.json({
      success: true,
      unassignedAssignmentId: result.unassignedAssignmentId,
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
