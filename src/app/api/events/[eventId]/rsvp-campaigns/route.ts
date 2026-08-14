/**
 * RSVP campaigns — list + create (organizer).
 *
 *   GET  → the event's RSVPs, each with its item + invite counts.
 *   POST → create one. Accepts an optional `firstItem` so the console's single
 *          create form produces campaign AND item together: an organizer
 *          running one dinner never sees the campaign as a separate step
 *          (docs/CUSTOMIZABLE_RSVP_PLAN.md §2a).
 *
 * Org-scoped via session; writes are denyReviewer-guarded + rate-limited.
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
import { rsvpCampaignCreateSchema, isDeadlineAfterItem } from "@/lib/rsvp/rsvp";
import { loadRsvpEvent } from "@/lib/rsvp/server";

type RouteParams = { params: Promise<{ eventId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Same guard as the roster GET: a campaign list exposes audience sizes,
    // so it is staff-only (R2 M4 alignment).
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "GET /events/[eventId]/rsvp-campaigns",
        eventId,
        userId: session.user.id,
      });
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaigns = await db.rsvpCampaign.findMany({
        where: { eventId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        include: {
          _count: { select: { items: true, invites: true } },
        },
      });

      // Responded count per campaign, for the list's "12 of 30 replied" line.
      const responded = await db.rsvpInvite.groupBy({
        by: ["campaignId"],
        where: { eventId, status: "RESPONDED" },
        _count: { _all: true },
      });
      const respondedByCampaign = new Map(
        responded.map((r) => [r.campaignId, r._count._all]),
      );

      return NextResponse.json({
        campaigns: campaigns.map((c) => ({
          ...c,
          itemCount: c._count.items,
          inviteCount: c._count.invites,
          respondedCount: respondedByCampaign.get(c.id) ?? 0,
        })),
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-campaigns:list-failed");
    return NextResponse.json({ error: "Failed to load RSVPs" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
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
      key: `rsvp-campaigns-write:${eventId}`,
      limit: 60,
      windowMs: 3600_000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "POST /events/[eventId]/rsvp-campaigns",
        eventId,
        userId: session.user.id,
      });
    }

    const parsed = rsvpCampaignCreateSchema.safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, {
        route: "POST /events/[eventId]/rsvp-campaigns",
        eventId,
        userId: session.user.id,
      });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", {
        route: "POST /events/[eventId]/rsvp-campaigns",
        eventId,
        userId: session.user.id,
      });
    }

    const c = parsed.data;
    const first = c.firstItem;
    if (first && isDeadlineAfterItem(first.startsAt, first.rsvpDeadline)) {
      return apiErrorResponse(
        400,
        "The RSVP deadline cannot be after the item itself.",
        {
          route: "POST /events/[eventId]/rsvp-campaigns",
          eventId,
          userId: session.user.id,
        },
        { code: "DEADLINE_AFTER_ITEM" },
      );
    }

    return await runWithTenant(event.organizationId, async () => {
      // Campaign + its first item commit together: a campaign created without
      // the item the operator just typed would leave an empty RSVP behind if
      // the second write failed.
      const campaign = await tenantTransaction(async (tx) => {
        const created = await tx.rsvpCampaign.create({
          data: {
            eventId,
            organizationId: event.organizationId,
            name: c.name,
            description: c.description || null,
            selectionMode: c.selectionMode ?? "MULTI",
            allowGuests: c.allowGuests ?? false,
            collectDietary: c.collectDietary ?? false,
            isActive: c.isActive ?? true,
            sortOrder: c.sortOrder ?? 0,
          },
        });

        if (first) {
          await tx.rsvpItem.create({
            data: {
              campaignId: created.id,
              eventId,
              organizationId: event.organizationId,
              name: first.name,
              startsAt: new Date(first.startsAt),
              location: first.location || null,
              description: first.description || null,
              rsvpDeadline: first.rsvpDeadline ? new Date(first.rsvpDeadline) : null,
              sortOrder: first.sortOrder ?? 0,
              isActive: first.isActive ?? true,
            },
          });
        }

        return created;
      });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "CREATE",
            entityType: "RSVP_CAMPAIGN",
            entityId: campaign.id,
            changes: {
              name: campaign.name,
              selectionMode: campaign.selectionMode,
              allowGuests: campaign.allowGuests,
              collectDietary: campaign.collectDietary,
              withFirstItem: Boolean(first),
            },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-campaigns:audit-failed"));

      return NextResponse.json({ campaign }, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-campaigns:create-failed");
    return NextResponse.json({ error: "Failed to create RSVP" }, { status: 500 });
  }
}
