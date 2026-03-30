import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { sendEmail, getEventTemplate, getDefaultTemplate, renderAndWrap, getAbstractStatusInfo, brandingFrom } from "@/lib/email";
import { getClientIp } from "@/lib/security";
import { notifyEventAdmins } from "@/lib/notifications";

const updateAbstractSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  trackId: z.string().max(100).nullable().optional(),
  specialty: z.string().max(255).optional(),
  presentationType: z.enum(["ORAL", "POSTER"]).nullable().optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]).optional(),
  reviewNotes: z.string().max(5000).optional(),
  reviewScore: z.number().min(0).max(100).nullable().optional(),
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

    // Only ADMIN/SUPER_ADMIN/REVIEWER can set review statuses, review notes, or review score
    const reviewStatuses = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"];
    if (!canReview) {
      if (data.status && reviewStatuses.includes(data.status)) {
        return NextResponse.json(
          { error: "Only reviewers and admins can set review status" },
          { status: 403 }
        );
      }
      if (data.reviewNotes !== undefined || data.reviewScore !== undefined) {
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
        ...(data.presentationType !== undefined && { presentationType: data.presentationType }),
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

    // Send notification email to speaker on review actions OR when feedback is added
    const hasFeedbackUpdate = !isReview && (data.reviewNotes !== undefined || data.reviewScore !== undefined);
    const shouldNotify = (isReview && data.status) || hasFeedbackUpdate;

    if (shouldNotify && abstract.speaker?.email) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
      const managementLink = abstract.event?.slug
        ? `${appUrl}/e/${abstract.event.slug}/login?redirect=abstracts`
        : `${appUrl}/login?callbackUrl=${encodeURIComponent("/events")}`;

      const effectiveStatus = data.status || abstract.status;
      const statusInfo = getAbstractStatusInfo(effectiveStatus);
      const reviewNotesHtml = (data.reviewNotes ?? abstract.reviewNotes)
        ? `<div style="background: #e0f2fe; padding: 15px; border-radius: 8px; border-left: 4px solid #0ea5e9; margin: 20px 0;"><strong>Reviewer Notes:</strong><br><span style="white-space: pre-wrap;">${data.reviewNotes ?? abstract.reviewNotes}</span></div>`
        : "";
      const effectiveScore = data.reviewScore ?? abstract.reviewScore;
      const vars: Record<string, string | number | undefined> = {
        firstName: abstract.speaker.firstName,
        lastName: abstract.speaker.lastName,
        eventName: event.name,
        abstractTitle: abstract.title,
        newStatus: effectiveStatus.replace(/_/g, " "),
        statusHeading: hasFeedbackUpdate ? "Reviewer Feedback Received" : statusInfo.heading,
        statusMessage: hasFeedbackUpdate
          ? "A reviewer has provided feedback on your abstract. Log in to view the details."
          : statusInfo.message,
        reviewNotes: reviewNotesHtml,
        reviewScore: effectiveScore ?? undefined,
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
          from: brandingFrom(branding),
        });
      }).catch((err) => {
        apiLogger.error({ err, msg: "Failed to send abstract notification email" });
      });
    }

    // Notify admins/organizers on review (non-blocking)
    if (isReview || hasFeedbackUpdate) {
      notifyEventAdmins(eventId, {
        type: "REVIEW",
        title: "Abstract Reviewed",
        message: `Abstract "${abstract.title}" reviewed${data.reviewScore != null ? ` — Score: ${data.reviewScore}/100` : ""}`,
        link: `/events/${eventId}/abstracts`,
      }).catch((err) => apiLogger.error({ err, msg: "Failed to send abstract review notification" }));
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
