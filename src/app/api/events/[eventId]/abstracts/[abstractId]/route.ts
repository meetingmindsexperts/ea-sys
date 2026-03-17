import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, getAbstractStatusInfo } from "@/lib/email";
import { getClientIp } from "@/lib/security";

const updateAbstractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).optional(),
  reviewNotes: z.string().max(5000).optional(),
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
      include: { speaker: { select: { userId: true } } },
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

    const isAdmin =
      session.user.role === "SUPER_ADMIN" || session.user.role === "ADMIN";

    // SUBMITTER restrictions: can only edit own abstracts, no review fields
    if (session.user.role === "SUBMITTER") {
      if (existingAbstract.speaker?.userId !== session.user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (data.reviewNotes !== undefined || data.reviewScore !== undefined) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
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
    }

    // Only ADMIN/SUPER_ADMIN can set review statuses, review notes, or review score
    const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
    if (!isAdmin) {
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json(
          { error: "Only admins can approve, reject, or set review status" },
          { status: 403 }
        );
      }
      if (data.reviewNotes !== undefined || data.reviewScore !== undefined) {
        return NextResponse.json(
          { error: "Only admins can add review notes or scores" },
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

    // Determine if this is a review action
    const isReview = data.status && ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"].includes(data.status);
    const isSubmission = data.status === "SUBMITTED" && existingAbstract.status === "DRAFT";

    const abstract = await db.abstract.update({
      where: { id: abstractId },
      data: {
        ...(data.title && { title: data.title }),
        ...(data.content && { content: data.content }),
        ...(data.trackId !== undefined && { trackId: data.trackId }),
        ...(data.specialty !== undefined && { specialty: data.specialty || null }),
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

    // Send status notification email to speaker if this is a review action
    if (isReview && abstract.speaker?.email && data.status) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const managementLink = `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`;

      const statusInfo = getAbstractStatusInfo(data.status);
      const reviewNotesHtml = data.reviewNotes
        ? `<div style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;"><strong>Reviewer Notes:</strong><br><span style="white-space: pre-wrap;">${data.reviewNotes}</span></div>`
        : "";
      const vars: Record<string, string | number | undefined> = {
        firstName: abstract.speaker.firstName,
        lastName: abstract.speaker.lastName,
        eventName: event.name,
        abstractTitle: abstract.title,
        newStatus: data.status.replace(/_/g, " "),
        statusHeading: statusInfo.heading,
        statusMessage: statusInfo.message,
        reviewNotes: reviewNotesHtml,
        reviewScore: data.reviewScore ?? undefined,
        managementLink,
      };

      getEventTemplate(eventId, "abstract-status-update").then((tpl) => {
        const t = tpl || getDefaultTemplate("abstract-status-update");
        if (!t) { apiLogger.warn({ msg: "No template found for abstract-status-update" }); return; }
        const branding = tpl?.branding || { eventName: event.name };
        const rendered = renderAndWrap(t, vars, branding);
        return sendEmail({
          to: [{ email: abstract.speaker.email, name: `${abstract.speaker.firstName} ${abstract.speaker.lastName}` }],
          ...rendered,
        });
      }).catch((err) => {
        apiLogger.error({ err, msg: "Failed to send abstract status notification email" });
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
    const { eventId, abstractId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { error: "Only super admins can delete abstracts" },
        { status: 403 }
      );
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
        changes: { deleted: abstract, ip: getClientIp(req) },
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
