import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { getClientIp } from "@/lib/security";

/**
 * Reviewer assignment for a specific abstract.
 *
 * Admins/organizers use POST here to assign a reviewer from the event's
 * reviewer pool to a specific abstract. This is additive — being in
 * `event.settings.reviewerUserIds` still grants global review rights on the
 * event's abstracts. Per-abstract assignments are useful for workload
 * distribution + conflict-of-interest tracking.
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

    const denied = denyReviewer(session);
    if (denied) return denied;

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

    const [event, abstract, user] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: { id: abstractId, eventId },
        select: { id: true },
      }),
      db.user.findUnique({
        where: { id: validated.data.userId },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
    ]);

    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!abstract) return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // Idempotent: return existing assignment on dup (audit's dedup-UX pattern)
    const existing = await db.abstractReviewer.findUnique({
      where: { abstractId_userId: { abstractId, userId: validated.data.userId } },
      select: { id: true, role: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          alreadyAssigned: true,
          existingAssignmentId: existing.id,
          currentRole: existing.role,
          message: `${user.firstName} ${user.lastName} is already assigned to this abstract as ${existing.role}`,
        },
        { status: 200 },
      );
    }

    const assignment = await db.abstractReviewer.create({
      data: {
        abstractId,
        userId: validated.data.userId,
        assignedById: session.user.id,
        role: validated.data.role ?? "SECONDARY",
        conflictFlag: validated.data.conflictFlag ?? false,
      },
      select: { id: true, role: true, assignedAt: true, conflictFlag: true },
    });

    apiLogger.info(
      { msg: "abstract-reviewer:assigned", eventId, abstractId, reviewerUserId: validated.data.userId, role: assignment.role },
    );

    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "ASSIGN",
        entityType: "AbstractReviewer",
        entityId: assignment.id,
        changes: { source: "api", abstractId, reviewerUserId: validated.data.userId, role: assignment.role, ip: getClientIp(req) },
      },
    }).catch((err) => apiLogger.error({ err, eventId, abstractId }, "assign-reviewer:audit-log-failed"));

    return NextResponse.json(
      {
        success: true,
        assignment: {
          ...assignment,
          reviewer: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email },
        },
      },
      { status: 201 },
    );
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

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: { id: eventId, organizationId: session.user.organizationId! },
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
  } catch (err) {
    apiLogger.error({ err, msg: "list-reviewers:failed" });
    return NextResponse.json(
      { error: "Failed to list reviewers", code: "LIST_REVIEWERS_FAILED" },
      { status: 500 },
    );
  }
}
