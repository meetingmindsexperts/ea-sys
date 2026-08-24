import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { assignReviewer, type AssignReviewerErrorCode } from "@/services/abstract-service";

/**
 * Reviewer assignment for a specific abstract.
 *
 * Admins/organizers use POST here to assign a reviewer from the event's
 * reviewer pool to a specific abstract. This is additive — being in
 * `event.settings.reviewerUserIds` still grants global review rights on the
 * event's abstracts. Per-abstract assignments are useful for workload
 * distribution + conflict-of-interest tracking.
 *
 * Domain logic (reviewable-status gate, upsert semantics, COI flag, audit,
 * reviewer notification) lives in abstract-service.assignReviewer, shared
 * with the MCP assign_reviewer_to_abstract tool — this route keeps auth,
 * Zod, and HTTP response shaping.
 *
 * Unassign is at DELETE /reviewers/[userId].
 */

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

const assignSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["PRIMARY", "SECONDARY", "CONSULTING"]).optional(),
  conflictFlag: z.boolean().optional(),
});

const HTTP_STATUS_FOR_ASSIGN: Record<AssignReviewerErrorCode, number> = {
  EVENT_NOT_FOUND: 404,
  ABSTRACT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  NOT_REVIEWABLE: 409,
  UNKNOWN: 500,
};

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session, body] = await Promise.all([
      params,
      auth(),
      req.json().catch(() => null),
    ]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/abstracts/[abstractId]/reviewers:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
    if (!body) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validated = assignSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "events/abstracts/reviewers:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const result = await assignReviewer({
      eventId,
      organizationId: orgGuard.orgId,
      abstractId,
      reviewerUserId: validated.data.userId,
      role: validated.data.role,
      conflictFlag: validated.data.conflictFlag,
      actorUserId: session.user.id,
      source: "rest",
      ip: getClientIp(req),
    });

    if (!result.ok) {
      if (result.code === "UNKNOWN") {
        // Stable 500 contract (review M2) — same body the route always returned.
        return NextResponse.json(
          { error: "Failed to assign reviewer", code: "ASSIGN_REVIEWER_FAILED" },
          { status: 500 },
        );
      }
      const status = HTTP_STATUS_FOR_ASSIGN[result.code] ?? 500;
      const payload =
        result.code === "NOT_REVIEWABLE"
          ? { error: result.message, code: result.code }
          : { error: result.message };
      return NextResponse.json(payload, { status });
    }

    const { assignment, reviewer } = result;
    if (result.kind === "noop") {
      return NextResponse.json(
        {
          alreadyAssigned: true,
          existingAssignmentId: assignment.id,
          currentRole: assignment.role,
          message: `${reviewer.firstName} ${reviewer.lastName} is already assigned to this abstract as ${assignment.role}`,
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        ...(result.kind === "updated" ? { updated: true } : {}),
        assignment: { ...assignment, reviewer },
      },
      { status: result.kind === "created" ? 201 : 200 },
    );
    });
  } catch (err) {
    apiLogger.error({ err, msg: "assign-reviewer:failed" });
    return NextResponse.json(
      {
        error: "Failed to assign reviewer",
        code: "ASSIGN_REVIEWER_FAILED",
        details: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

/**
 * GET — list reviewers assigned to this specific abstract (with their
 * submission status).
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, abstractId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // WHO reviewed an abstract, and what they scored it, is STAFF-ONLY:
    // showing it to the author breaks blind review, and showing it to a
    // reviewer reveals their co-reviewers. `denyReviewer` runs BEFORE
    // `requireOrgId` here (the opposite order to this file's POST) on purpose:
    // it is the policy gate, and it must be the stated reason a restricted
    // caller is refused.
    //
    // Until Aug 24, 2026 this GET had no policy gate at all. The only thing
    // refusing a submitter was `requireOrgId` (they are org-null), which is the
    // right answer for the wrong reason, and it refused NOTHING org-bound: a
    // MEMBER passed it and read every abstract's reviewer list, because
    // `buildEventAccessWhere` gives MEMBER the whole org and the abstract
    // lookup below is not ownership-scoped. Do not remove either guard on the
    // strength of the comment that used to sit below this one.
    const denied = denyReviewer(session, {
      route: "events/[eventId]/abstracts/[abstractId]/reviewers:GET",
      eventId,
    });
    if (denied) return denied;

    const orgGuard = requireOrgId(session, { route: "events/[eventId]/abstracts/[abstractId]/reviewers:GET" });
    if ("error" in orgGuard) return orgGuard.error;

    return await runWithTenant(orgGuard.orgId, async () => {
    // buildEventAccessWhere rather than a bare `organizationId!` filter, which
    // threw a Prisma validation error ("must not be null") for org-null callers
    // (47870cc3, July 2 2026). Its org-null branches are now unreachable from
    // this route by design — the guards above admit staff only.
    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
    ]);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });

    const assignments = await db.abstractReviewer.findMany({
      where: { abstractId },
      select: {
        id: true,
        role: true,
        assignedAt: true,
        conflictFlag: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        submissions: {
          select: { id: true, overallScore: true, submittedAt: true, updatedAt: true },
          orderBy: { submittedAt: "desc" },
          take: 1,
        },
      },
      orderBy: [{ role: "asc" }, { assignedAt: "asc" }],
    });

    return NextResponse.json({
      reviewers: assignments.map((a) => ({
        assignmentId: a.id,
        role: a.role,
        assignedAt: a.assignedAt,
        conflictFlag: a.conflictFlag,
        user: a.user,
        hasSubmitted: a.submissions.length > 0,
        submission: a.submissions[0] ?? null,
      })),
      total: assignments.length,
    });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "list-reviewers:failed" });
    return NextResponse.json(
      { error: "Failed to list reviewers", code: "LIST_REVIEWERS_FAILED" },
      { status: 500 },
    );
  }
}
