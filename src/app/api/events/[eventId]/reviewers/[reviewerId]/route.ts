import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

interface RouteParams {
  params: Promise<{ eventId: string; reviewerId: string }>;
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId, reviewerId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true, settings: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const settings = (event.settings as Record<string, unknown>) || {};
    const reviewerUserIds = (settings.reviewerUserIds as string[]) || [];

    if (!reviewerUserIds.includes(reviewerId)) {
      return NextResponse.json(
        { error: "Reviewer not found for this event" },
        { status: 404 }
      );
    }

    // Remove reviewer from event settings
    await db.event.update({
      where: { id: eventId },
      data: {
        settings: {
          ...settings,
          reviewerUserIds: reviewerUserIds.filter((id) => id !== reviewerId),
        },
      },
    });

    // Audit log (non-blocking)
    db.auditLog.create({
      data: {
        eventId,
        userId: session.user.id,
        action: "DELETE",
        entityType: "EventReviewer",
        entityId: reviewerId,
        changes: { removedUserId: reviewerId },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log" }));

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error removing reviewer" });
    return NextResponse.json(
      { error: "Failed to remove reviewer" },
      { status: 500 }
    );
  }
}
