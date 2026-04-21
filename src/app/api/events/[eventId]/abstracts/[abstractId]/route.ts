import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";
import {
  computeSubmissionAggregates,
  consolidateReviewNotes,
  readRequiredReviewCount,
} from "@/lib/abstract-review";
import { refreshEventStats } from "@/lib/event-stats";

// Sprint B: review scoring moved to AbstractReviewSubmission rows.
// This PUT handles abstract metadata + status transitions only.
// Individual reviewer submissions go through POST /submissions.
const updateAbstractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  themeId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  presentationType: z.enum(["ORAL", "POSTER", "VIDEO", "WORKSHOP"]).nullable().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
  /** Organizer/chair override: bypass the requiredReviewCount gate. Logged. */
  forceStatus: z.boolean().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: {
          speaker: true,
          track: true,
          theme: { select: { id: true, name: true } },
          eventSession: {
            include: {
              track: true,
              speakers: {
                include: {
                  speaker: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    if (
      session.user.role === "SUBMITTER" &&
      abstract.speaker?.userId !== session.user.id
    ) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    return NextResponse.json(abstract);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching abstract" });
    return NextResponse.json(
      { error: "Failed to fetch abstract" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [event, existingAbstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true, name: true, settings: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: { speaker: { select: { userId: true } } },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!existingAbstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateAbstractSchema.safeParse(body);

    if (!validated.success) {
      const details = validated.error.flatten();
      apiLogger.warn({ msg: "Abstract update validation failed", eventId, abstractId, userId: session.user.id, errors: details });
      return NextResponse.json(
        { error: "Invalid input", details },
        { status: 400 }
      );
    }

    const data = validated.data;

    const isAdmin =
      session.user.role === "SUPER_ADMIN" || session.user.role === "ADMIN" || session.user.role === "ORGANIZER";
    const isReviewer = session.user.role === "REVIEWER";
    const canReview = isAdmin || isReviewer;
    const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];

    // SUBMITTER restrictions: can only edit own abstracts, can't set review statuses
    if (session.user.role === "SUBMITTER") {
      if (existingAbstract.speaker?.userId !== session.user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];
      if (!editableStatuses.includes(existingAbstract.status)) {
        return NextResponse.json(
          { error: "Cannot edit abstract in current status" },
          { status: 403 }
        );
      }
      // Submitters can't force status transitions
      if (data.forceStatus) {
        return NextResponse.json({ error: "Only admins can force status" }, { status: 403 });
      }
    }

    // Only ADMIN/SUPER_ADMIN/ORGANIZER/REVIEWER can set review statuses
    if (!canReview && data.status && reviewStatuses.includes(data.status)) {
      return NextResponse.json(
        { error: "Only reviewers and admins can set review status" },
        { status: 403 }
      );
    }

    // forceStatus override is admin-only
    if (data.forceStatus && !isAdmin) {
      return NextResponse.json(
        { error: "Only admins can bypass the review-count gate" },
        { status: 403 }
      );
    }

    // Verify track exists if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // Verify theme belongs to this event if provided
    if (data.themeId) {
      const theme = await db.abstractTheme.findFirst({
        where: { id: data.themeId, eventId },
        select: { id: true },
      });
      if (!theme) {
        return NextResponse.json({ error: "Theme not found" }, { status: 404 });
      }
    }

    // Gate ACCEPTED / REJECTED transitions on minimum review submissions.
    // `forceStatus: true` bypasses the gate (logged as chair override).
    const gateRelevant = data.status === "ACCEPTED" || data.status === "REJECTED";
    let aggregateResult: Awaited<ReturnType<typeof computeSubmissionAggregates>> | null = null;
    if (gateRelevant) {
      aggregateResult = await computeSubmissionAggregates(abstractId);
      const requiredCount = readRequiredReviewCount(event.settings);
      if (!data.forceStatus && aggregateResult.aggregates.count < requiredCount) {
        apiLogger.warn(
          { abstractId, currentCount: aggregateResult.aggregates.count, required: requiredCount, userId: session.user.id },
          "abstract-status:insufficient-reviews",
        );
        return NextResponse.json(
          {
            error: `This event requires ${requiredCount} review submission(s) before ${data.status}. Current: ${aggregateResult.aggregates.count}.`,
            code: "INSUFFICIENT_REVIEWS",
            currentCount: aggregateResult.aggregates.count,
            required: requiredCount,
          },
          { status: 400 }
        );
      }
    }

    // Determine if this is a review action
    const isReview = data.status && reviewStatuses.includes(data.status);
    const isSubmission = data.status === "SUBMITTED" && existingAbstract.status === "DRAFT";

    const abstract = await db.abstract.update({
      where: { id: abstractId },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.content && { content: data.content }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(data.themeId !== undefined && { themeId: data.themeId }),
        ...(data.specialty !== undefined && { specialty: data.specialty || null }),
        ...(data.presentationType !== undefined && { presentationType: data.presentationType }),
        ...(data.status && { status: data.status }),
        ...(isReview && { reviewedAt: new Date() }),
        ...(isSubmission && { submittedAt: new Date() }),
      },
      include: {
        speaker: true,
        track: true,
        eventSession: true,
        event: { select: { slug: true, name: true } },
      },
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    apiLogger.info(
      { msg: "abstract-status:changed", eventId, abstractId, userId: session.user.id, previousStatus: existingAbstract.status, newStatus: abstract.status, force: data.forceStatus ?? false },
    );

    // Fire-and-forget audit log so a write failure doesn't block the response
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: isReview ? "REVIEW" : "UPDATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: { status: existingAbstract.status },
          after: { status: abstract.status },
          source: data.forceStatus ? "chair-override" : "api",
          reviewCount: aggregateResult?.aggregates.count ?? null,
          meanOverall: aggregateResult?.aggregates.meanOverall ?? null,
          fieldsChanged: Object.keys(data),
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, eventId, abstractId }, "abstract-update:audit-log-failed"));

    // Notification: fires on status transition to a review status only.
    // Feedback-only updates no longer exist at this level — reviewers add
    // feedback via POST /submissions which has its own flow.
    if (isReview && data.status) {
      const notifyAggregate = aggregateResult ?? await computeSubmissionAggregates(abstractId);
      notifyAbstractStatusChange({
        eventId,
        eventName: event.name,
        eventSlug: abstract.event?.slug ?? null,
        abstractId: abstract.id,
        abstractTitle: abstract.title,
        previousStatus: existingAbstract.status,
        newStatus: data.status,
        reviewNotes: consolidateReviewNotes(notifyAggregate.submissions),
        reviewScore: notifyAggregate.aggregates.meanOverall,
        speaker: {
          id: abstract.speaker?.id,
          email: abstract.speaker?.email ?? null,
          firstName: abstract.speaker?.firstName ?? "",
          lastName: abstract.speaker?.lastName ?? "",
        },
      }).catch((err) => {
        apiLogger.error({ err, eventId, abstractId }, "abstract-status:notification-failed");
      });
    }

    return NextResponse.json(abstract);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating abstract" });
    return NextResponse.json(
      { error: "Failed to update abstract" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, abstractId }] = await Promise.all([auth(), params]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { error: "Only super admins can delete abstracts" },
        { status: 403 }
      );
    }

    const [event, abstract] = await Promise.all([
      db.event.findFirst({
        where: buildEventAccessWhere(session.user, eventId),
        select: { id: true },
      }),
      db.abstract.findFirst({
        where: {
          id: abstractId,
          eventId,
        },
        include: {
          eventSession: true,
        },
      }),
    ]);

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    // Don't allow deletion if linked to a session
    if (abstract.eventSession) {
      return NextResponse.json(
        { error: "Cannot delete abstract that is linked to a session" },
        { status: 400 }
      );
    }

    await db.abstract.delete({
      where: { id: abstractId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "Abstract",
        entityId: abstractId,
        changes: { deleted: abstract, ip: getClientIp(req) },
      },
    });

    apiLogger.info({ msg: "Abstract deleted", eventId, abstractId, title: abstract.title, userId: session.user.id });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting abstract" });
    return NextResponse.json(
      { error: "Failed to delete abstract" },
      { status: 500 }
    );
  }
}
