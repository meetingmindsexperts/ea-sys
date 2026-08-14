/**
 * RSVP — remove a single invitee from a campaign (organizer).
 *   DELETE → deletes the invite (cascades its RsvpResponse rows).
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { apiErrorResponse } from "@/lib/api-errors";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";

type RouteParams = {
  params: Promise<{ eventId: string; campaignId: string; inviteId: string }>;
};

export async function DELETE(_req: Request, { params }: RouteParams) {
  const route = "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]/invites/[inviteId]";
  try {
    const [session, { eventId, campaignId, inviteId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    // Resource-org lane for the swept RsvpInvite find + delete.
    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }

      const invite = await db.rsvpInvite.findFirst({
        where: { id: inviteId, campaignId },
        // Snapshot for the audit row (review R2 L13) — an empty `{}` couldn't
        // even answer WHO was removed from the guest list. Token excluded.
        select: { id: true, inviteeName: true, inviteeEmail: true, status: true, respondedAt: true },
      });
      if (!invite) {
        return apiErrorResponse(404, "Invite not found", {
          route, eventId, campaignId, inviteId, userId: session.user.id,
        });
      }

      const { count } = await db.rsvpInvite.deleteMany({ where: { id: inviteId, campaignId } });
      if (count === 0) {
        return apiErrorResponse(404, "Invite not found", {
          route, eventId, campaignId, inviteId, userId: session.user.id,
        });
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE",
            entityType: "RSVP_INVITE",
            entityId: inviteId,
            changes: {
              campaignId,
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
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-invites:delete-failed");
    return NextResponse.json({ error: "Failed to remove invitee" }, { status: 500 });
  }
}
