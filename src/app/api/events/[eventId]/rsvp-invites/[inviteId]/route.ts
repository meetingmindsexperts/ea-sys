/**
 * Dinner RSVP — remove a single invitee (organizer).
 *   DELETE → deletes the invite (cascades its RsvpDinnerResponse rows).
 * Docs: docs/DINNER_RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";

type RouteParams = { params: Promise<{ eventId: string; inviteId: string }> };

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, inviteId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, inviteId, userId: session.user.id }, "rsvp-invites:delete-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const invite = await db.rsvpInvite.findFirst({
      where: { id: inviteId, eventId },
      // Snapshot for the audit row (review R2 L13) — an empty `{}` couldn't
      // even answer WHO was removed from the guest list. Token excluded.
      select: { id: true, inviteeName: true, inviteeEmail: true, status: true, respondedAt: true },
    });
    if (!invite) {
      apiLogger.warn({ eventId, inviteId, userId: session.user.id }, "rsvp-invites:invite-not-found");
      return NextResponse.json({ error: "Invite not found" }, { status: 404 });
    }

    await db.rsvpInvite.delete({ where: { id: inviteId } });

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "DELETE",
          entityType: "RSVP_INVITE",
          entityId: inviteId,
          changes: {
            deleted: {
              inviteeName: invite.inviteeName,
              inviteeEmail: invite.inviteeEmail,
              status: invite.status,
              respondedAt: invite.respondedAt,
            },
          },
        },
      })
      .catch((err) => apiLogger.error({ err }, "rsvp-invites:audit-failed"));

    return NextResponse.json({ ok: true });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:delete-failed");
    return NextResponse.json({ error: "Failed to remove invitee" }, { status: 500 });
  }
}
