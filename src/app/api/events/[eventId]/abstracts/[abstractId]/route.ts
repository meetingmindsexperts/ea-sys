import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { getClientIp } from "@/lib/security";
import { notifyAbstractStatusChange } from "@/lib/abstract-notifications";

const criteriaScoreItemSchema = z.object({
  criterionId: z.string(),
  name: z.string(),
  weight: z.number().int().min(1).max(100),
  score: z.number().int().min(0).max(100),
});

const updateAbstractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  themeId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  presentationType: z.enum(["ORAL", "POSTER", "VIDEO", "WORKSHOP"]).nullable().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
  reviewNotes: z.string().max(5000).optional(),
  reviewScore: z.number().min(0).max(100).nullable().optional(),
  criteriaScores: z.array(criteriaScoreItemSchema).nullable().optional(),
  recommendedFormat: z.enum(["ORAL", "POSTER", "NEITHER"]).nullable().optional(),
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
        select: { id: true, name: true },
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
      session.user.role === "SUPER_ADMIN" || session.user.role === "ADMIN";
    const isReviewer = session.user.role === "REVIEWER";
    const canReview = isAdmin || isReviewer;

    // SUBMITTER restrictions: can only edit own abstracts, no review fields
    if (session.user.role === "SUBMITTER") {
      if (existingAbstract.speaker?.userId !== session.user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (data.reviewNotes !== undefined || data.reviewScore !== undefined || data.criteriaScores !== undefined || data.recommendedFormat !== undefined) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      // Submitter may withdraw their own abstract from editable states
      const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];
      if (!editableStatuses.includes(existingAbstract.status)) {
        return NextResponse.json(
          { error: "Cannot edit abstract in current status" },
          { status: 403 }
        );
      }
    }

    // Only ADMIN/SUPER_ADMIN/REVIEWER can set review statuses, review notes, or review score
    const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
    if (!canReview) {
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json(
          { error: "Only reviewers and admins can set review status" },
          { status: 403 }
        );
      }
      if (data.reviewNotes !== undefined || data.reviewScore !== undefined || data.criteriaScores !== undefined || data.recommendedFormat !== undefined) {
        return NextResponse.json(
          { error: "Only reviewers and admins can add review notes or scores" },
          { status: 403 }
        );
      }
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

    // Compute weighted score from criteria if provided; otherwise use plain reviewScore
    let computedReviewScore: number | null | undefined = data.reviewScore;
    if (data.criteriaScores && data.criteriaScores.length > 0) {
      computedReviewScore = Math.round(
        data.criteriaScores.reduce((sum, c) => sum + (c.score * c.weight) / 100, 0)
      );
    }

    // Determine if this is a review action
    const isReview = data.status && ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"].includes(data.status);
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
        ...(data.reviewNotes !== undefined && { reviewNotes: data.reviewNotes || null }),
        ...(computedReviewScore !== undefined && { reviewScore: computedReviewScore }),
        ...(data.criteriaScores !== undefined && { criteriaScores: data.criteriaScores ?? undefined }),
        ...(data.recommendedFormat !== undefined && { recommendedFormat: data.recommendedFormat }),
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

    // Log the action
    await db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: isReview ? "REVIEW" : "UPDATE",
        entityType: "Abstract",
        entityId: abstract.id,
        changes: {
          before: existingAbstract,
          after: abstract,
          ip: getClientIp(req),
        },
      },
    });

    const hasFeedbackUpdate = !isReview && (data.reviewNotes !== undefined || data.reviewScore !== undefined);
    const shouldNotify = (isReview && !!data.status) || hasFeedbackUpdate;

    if (shouldNotify) {
      notifyAbstractStatusChange({
        eventId,
        eventName: event.name,
        eventSlug: abstract.event?.slug ?? null,
        abstractId: abstract.id,
        abstractTitle: abstract.title,
        previousStatus: existingAbstract.status,
        newStatus: data.status || abstract.status,
        reviewNotes: data.reviewNotes ?? abstract.reviewNotes ?? null,
        reviewScore: data.reviewScore ?? abstract.reviewScore ?? null,
        speaker: {
          email: abstract.speaker?.email ?? null,
          firstName: abstract.speaker?.firstName ?? "",
          lastName: abstract.speaker?.lastName ?? "",
        },
        feedbackOnly: hasFeedbackUpdate,
      }).catch((err) => {
        apiLogger.error({ err, msg: "notifyAbstractStatusChange failed", eventId, abstractId });
      });
    }

    apiLogger.info({ msg: "Abstract updated", eventId, abstractId, userId: session.user.id, changes: Object.keys(data) });

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
