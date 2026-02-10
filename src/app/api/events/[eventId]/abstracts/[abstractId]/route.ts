import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";

const updateAbstractSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  trackId: z.string().nullable().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).optional(),
  reviewNotes: z.string().optional(),
  reviewScore: z.number().min(0).max(100).nullable().optional(),
});

interface RouteParams {
  params: Promise<{ eventId: string; abstractId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { eventId, abstractId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const abstract = await db.abstract.findFirst({
      where: {
        id: abstractId,
        eventId,
      },
      include: {
        speaker: true,
        track: true,
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
    });

    if (!abstract) {
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
    const { eventId, abstractId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }


    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const existingAbstract = await db.abstract.findFirst({
      where: {
        id: abstractId,
        eventId,
      },
    });

    if (!existingAbstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = updateAbstractSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const data = validated.data;

    // Verify track exists if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
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
        ...(data.status && { status: data.status }),
        ...(data.reviewNotes !== undefined && { reviewNotes: data.reviewNotes || null }),
        ...(data.reviewScore !== undefined && { reviewScore: data.reviewScore }),
        ...(isReview && { reviewedAt: new Date() }),
        ...(isSubmission && { submittedAt: new Date() }),
      },
      include: {
        speaker: true,
        track: true,
        eventSession: true,
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
        },
      },
    });

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
    const { eventId, abstractId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role === "REVIEWER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const abstract = await db.abstract.findFirst({
      where: {
        id: abstractId,
        eventId,
      },
      include: {
        eventSession: true,
      },
    });

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
        changes: { deleted: abstract },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting abstract" });
    return NextResponse.json(
      { error: "Failed to delete abstract" },
      { status: 500 }
    );
  }
}
