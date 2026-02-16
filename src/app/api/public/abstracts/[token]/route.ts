import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

const updateAbstractSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  trackId: z.string().nullable().optional(),
});

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { token } = await params;

    const abstract = await db.abstract.findUnique({
      where: { managementToken: token },
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        reviewNotes: true,
        reviewScore: true,
        submittedAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
        track: {
          select: { id: true, name: true },
        },
        speaker: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            company: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            settings: true,
            tracks: {
              select: { id: true, name: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
      },
    });

    if (!abstract) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    // Determine if editable based on status
    const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];
    const isEditable = editableStatuses.includes(abstract.status);

    // Check if deadline has passed
    const settings = (abstract.event.settings || {}) as Record<string, unknown>;
    const deadline = settings.abstractDeadline
      ? new Date(settings.abstractDeadline as string)
      : null;
    const deadlinePassed = deadline ? new Date() > deadline : false;

    return NextResponse.json({
      ...abstract,
      event: {
        id: abstract.event.id,
        name: abstract.event.name,
        slug: abstract.event.slug,
        tracks: abstract.event.tracks,
      },
      isEditable: isEditable && !deadlinePassed,
      deadlinePassed,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching abstract by token" });
    return NextResponse.json(
      { error: "Failed to fetch abstract" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { token } = await params;

    const existing = await db.abstract.findUnique({
      where: { managementToken: token },
      select: {
        id: true,
        status: true,
        eventId: true,
        event: {
          select: { settings: true },
        },
      },
    });

    if (!existing) {
      return NextResponse.json({ error: "Abstract not found" }, { status: 404 });
    }

    // Only allow edits for certain statuses
    const editableStatuses = ["DRAFT", "SUBMITTED", "REVISION_REQUESTED"];
    if (!editableStatuses.includes(existing.status)) {
      return NextResponse.json(
        { error: "This abstract can no longer be edited" },
        { status: 403 }
      );
    }

    // Check deadline
    const settings = (existing.event.settings || {}) as Record<string, unknown>;
    if (settings.abstractDeadline) {
      const deadline = new Date(settings.abstractDeadline as string);
      if (new Date() > deadline) {
        return NextResponse.json(
          { error: "The abstract submission deadline has passed" },
          { status: 403 }
        );
      }
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

    // Verify track if provided
    if (data.trackId) {
      const track = await db.track.findFirst({
        where: { id: data.trackId, eventId: existing.eventId },
      });
      if (!track) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
    }

    // If revision was requested and speaker is editing, set status back to SUBMITTED
    const newStatus = existing.status === "REVISION_REQUESTED" ? "SUBMITTED" : undefined;

    const abstract = await db.abstract.update({
      where: { managementToken: token },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.content && { content: data.content }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(newStatus && { status: newStatus, submittedAt: new Date() }),
      },
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        trackId: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(abstract);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating abstract by token" });
    return NextResponse.json(
      { error: "Failed to update abstract" },
      { status: 500 }
    );
  }
}
