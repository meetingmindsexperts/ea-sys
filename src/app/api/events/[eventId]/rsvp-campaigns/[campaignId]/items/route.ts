/**
 * RSVP items — list + create within a campaign (organizer).
 *
 * An "item" is one thing an invitee can say yes to: a dinner night, a workshop
 * slot, a site visit. Was the standalone `/dinners` route until Aug 14, 2026;
 * items are now campaign-scoped, which is what lets one event run several
 * RSVPs with different audiences.
 *
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited, zodErrorResponse, apiErrorResponse } from "@/lib/api-errors";
import { rsvpItemInputSchema, isDeadlineAfterItem } from "@/lib/rsvp/rsvp";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";

type RouteParams = { params: Promise<{ eventId: string; campaignId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, campaignId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "GET /events/[eventId]/rsvp-campaigns/[campaignId]/items",
        eventId,
        userId: session.user.id,
      });
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "GET /events/[eventId]/rsvp-campaigns/[campaignId]/items",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }

      const items = await db.rsvpItem.findMany({
        where: { campaignId },
        orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }],
      });
      return NextResponse.json({ items, campaign });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-items:list-failed");
    return NextResponse.json({ error: "Failed to load items" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, campaignId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    const limit = checkRateLimit({
      key: `rsvp-items-write:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "POST /events/[eventId]/rsvp-campaigns/[campaignId]/items",
        eventId,
        campaignId,
        userId: session.user.id,
      });
    }

    const parsed = rsvpItemInputSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, {
        route: "POST /events/[eventId]/rsvp-campaigns/[campaignId]/items",
        eventId,
        campaignId,
        userId: session.user.id,
      });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "POST /events/[eventId]/rsvp-campaigns/[campaignId]/items",
        eventId,
        userId: session.user.id,
      });
    }

    const d = parsed.data;
    if (isDeadlineAfterItem(d.startsAt, d.rsvpDeadline)) {
      return apiErrorResponse(
        400,
        "The RSVP deadline cannot be after the item itself.",
        {
          route: "POST /events/[eventId]/rsvp-campaigns/[campaignId]/items",
          eventId,
          campaignId,
          userId: session.user.id,
        },
        { code: "DEADLINE_AFTER_ITEM" },
      );
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route: "POST /events/[eventId]/rsvp-campaigns/[campaignId]/items",
          eventId,
          campaignId,
          userId: session.user.id,
        });
      }

      const item = await db.rsvpItem.create({
        data: {
          campaignId,
          // Always derived from the campaign, never taken from input — the
          // denormalized eventId must not be able to drift from its campaign.
          eventId: campaign.eventId,
          organizationId: event.organizationId,
          name: d.name,
          startsAt: new Date(d.startsAt),
          location: d.location || null,
          description: d.description || null,
          rsvpDeadline: d.rsvpDeadline ? new Date(d.rsvpDeadline) : null,
          sortOrder: d.sortOrder ?? 0,
          isActive: d.isActive ?? true,
        },
      });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "CREATE",
            entityType: "RSVP_ITEM",
            entityId: item.id,
            changes: { campaignId, name: item.name, startsAt: item.startsAt },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-items:audit-failed"));

      return NextResponse.json({ item }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-items:create-failed");
    return NextResponse.json({ error: "Failed to create item" }, { status: 500 });
  }
}
