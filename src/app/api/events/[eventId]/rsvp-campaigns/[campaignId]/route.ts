/**
 * RSVP campaign — read / update / delete one (organizer).
 *
 * DELETE cascades to the campaign's items, invites and responses (schema-level
 * onDelete: Cascade), so the confirm copy in the console must say so.
 *
 * Every lookup binds `{ id, eventId }`: a campaign id from another event must
 * not resolve against this URL even for a caller who legitimately holds both.
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse, apiErrorResponse } from "@/lib/api-errors";
import { rsvpCampaignUpdateSchema } from "@/lib/rsvp/rsvp";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";

type RouteParams = { params: Promise<{ eventId: string; campaignId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, campaignId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]:GET" });
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "GET /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        userId: session.user.id,
      });
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "GET /events/[eventId]/rsvp-campaigns/[campaignId]",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }
      return NextResponse.json({ campaign });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-campaigns:get-failed");
    return NextResponse.json({ error: "Failed to load RSVP" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, campaignId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]:PUT" });
    if (denied) return denied;

    const limit = checkRateLimit({
      key: `rsvp-campaigns-write:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "PUT /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        campaignId,
        userId: session.user.id,
      });
    }

    const parsed = rsvpCampaignUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, {
        route: "PUT /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        campaignId,
        userId: session.user.id,
      });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "PUT /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        userId: session.user.id,
      });
    }

    return await runWithTenant(event.organizationId, async () => {
      const existing = await loadRsvpCampaign(campaignId, eventId);
      if (!existing) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "PUT /events/[eventId]/rsvp-campaigns/[campaignId]",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }

      const p = parsed.data;

      // Turning guests OFF must reconcile the answers already on file, in the
      // same transaction as the flag. Otherwise the headcount tile keeps summing
      // guestCount ("20 attending +15 guests · 35 seats") while the CSV drops the
      // guest columns entirely — so the organizer hands the caterer an export
      // whose total they cannot explain, and the invitee can no longer correct it
      // because the input is gone. Config that changes what a field MEANS has to
      // migrate the field.
      const turningGuestsOff = p.allowGuests === false && existing.allowGuests;
      let guestsCleared = 0;

      await tenantTransaction(async (tx) => {
        // updateMany bound to { id, eventId }: the org binding is atomic with
        // the write, not merely checked by the read above.
        await tx.rsvpCampaign.updateMany({
          where: { id: campaignId, eventId },
          data: {
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.description !== undefined ? { description: p.description || null } : {}),
            ...(p.selectionMode !== undefined ? { selectionMode: p.selectionMode } : {}),
            ...(p.allowGuests !== undefined ? { allowGuests: p.allowGuests } : {}),
            ...(p.collectDietary !== undefined ? { collectDietary: p.collectDietary } : {}),
            ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
            ...(p.sortOrder !== undefined ? { sortOrder: p.sortOrder } : {}),
          },
        });

        if (turningGuestsOff) {
          const { count } = await tx.rsvpResponse.updateMany({
            where: { invite: { campaignId }, guestCount: { gt: 0 } },
            data: { guestCount: 0 },
          });
          guestsCleared = count;
        }
      });

      if (guestsCleared > 0) {
        apiLogger.info(
          { eventId, campaignId, guestsCleared, userId: session.user.id },
          "rsvp-campaigns:guest-counts-cleared",
        );
      }

      const campaign = await loadRsvpCampaign(campaignId, eventId);

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "RSVP_CAMPAIGN",
            entityId: campaignId,
            changes: {
              before: {
                name: existing.name,
                selectionMode: existing.selectionMode,
                allowGuests: existing.allowGuests,
                collectDietary: existing.collectDietary,
                isActive: existing.isActive,
              },
              guestsCleared,
              after: {
                name: campaign?.name,
                selectionMode: campaign?.selectionMode,
                allowGuests: campaign?.allowGuests,
                collectDietary: campaign?.collectDietary,
                isActive: campaign?.isActive,
              },
            },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-campaigns:update-audit-failed"));

      return NextResponse.json({ campaign });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-campaigns:update-failed");
    return NextResponse.json({ error: "Failed to update RSVP" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, campaignId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]:DELETE" });
    if (denied) return denied;

    const limit = checkRateLimit({
      key: `rsvp-campaigns-write:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        campaignId,
        userId: session.user.id,
      });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]",
        eventId,
        userId: session.user.id,
      });
    }

    return await runWithTenant(event.organizationId, async () => {
      const existing = await loadRsvpCampaign(campaignId, eventId);
      if (!existing) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }

      // Snapshot the counts BEFORE the cascade so the audit row records what
      // was actually destroyed — after the delete they are unknowable.
      const [itemCount, inviteCount] = await Promise.all([
        db.rsvpItem.count({ where: { campaignId } }),
        db.rsvpInvite.count({ where: { campaignId } }),
      ]);

      const { count } = await db.rsvpCampaign.deleteMany({
        where: { id: campaignId, eventId },
      });
      if (count === 0) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE",
            entityType: "RSVP_CAMPAIGN",
            entityId: campaignId,
            changes: { name: existing.name, itemCount, inviteCount },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-campaigns:delete-audit-failed"));

      return NextResponse.json({ success: true, itemCount, inviteCount });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-campaigns:delete-failed");
    return NextResponse.json({ error: "Failed to delete RSVP" }, { status: 500 });
  }
}
