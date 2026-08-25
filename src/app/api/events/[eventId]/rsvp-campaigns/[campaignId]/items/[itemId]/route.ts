/**
 * RSVP item — update / delete one (organizer).
 *   PUT    → edit an item.
 *   DELETE → remove it (cascades its RsvpResponse rows).
 *
 * Every lookup and write binds `{ id, campaignId }` AND resolves the campaign
 * against `{ id, eventId }` first, so an item id from another campaign (or
 * another event) cannot resolve against this URL.
 *
 * Docs: docs/RSVP.md.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { zodErrorResponse, apiErrorResponse } from "@/lib/api-errors";
import { rsvpItemInputSchema, isDeadlineAfterItem } from "@/lib/rsvp/rsvp";
import { loadRsvpEvent, loadRsvpCampaign } from "@/lib/rsvp/server";

type RouteParams = {
  params: Promise<{ eventId: string; campaignId: string; itemId: string }>;
};

const ITEM_SELECT = {
  id: true,
  name: true,
  startsAt: true,
  location: true,
  description: true,
  rsvpDeadline: true,
  sortOrder: true,
  isActive: true,
} as const;

export async function PUT(req: Request, { params }: RouteParams) {
  const route = "PUT /events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]";
  try {
    const [session, { eventId, campaignId, itemId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]:PUT" });
    if (denied) return denied;

    const parsed = rsvpItemInputSchema.partial().safeParse(body);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route, eventId, campaignId, itemId, userId: session.user.id });
    }

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }
      const item = await db.rsvpItem.findFirst({
        where: { id: itemId, campaignId },
        select: ITEM_SELECT,
      });
      if (!item) {
        return apiErrorResponse(404, "Item not found", {
          route, eventId, campaignId, itemId, userId: session.user.id,
        });
      }

      const d = parsed.data;
      // Effective (merged) cross-field check — the PUT is partial, so either
      // side of the pair may come from the stored row (review R2 L7).
      const effectiveStartsAt = d.startsAt !== undefined ? d.startsAt : item.startsAt;
      const effectiveDeadline = d.rsvpDeadline !== undefined ? d.rsvpDeadline : item.rsvpDeadline;
      if (isDeadlineAfterItem(effectiveStartsAt, effectiveDeadline)) {
        return apiErrorResponse(
          400,
          "The RSVP deadline cannot be after the item itself.",
          { route, eventId, campaignId, itemId, userId: session.user.id },
          { code: "DEADLINE_AFTER_ITEM" },
        );
      }

      await db.rsvpItem.updateMany({
        where: { id: itemId, campaignId },
        data: {
          ...(d.name !== undefined && { name: d.name }),
          ...(d.startsAt !== undefined && { startsAt: new Date(d.startsAt) }),
          ...(d.location !== undefined && { location: d.location || null }),
          ...(d.description !== undefined && { description: d.description || null }),
          ...(d.rsvpDeadline !== undefined && {
            rsvpDeadline: d.rsvpDeadline ? new Date(d.rsvpDeadline) : null,
          }),
          ...(d.sortOrder !== undefined && { sortOrder: d.sortOrder }),
          ...(d.isActive !== undefined && { isActive: d.isActive }),
        },
      });
      const updated = await db.rsvpItem.findFirst({ where: { id: itemId, campaignId } });

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "UPDATE",
            entityType: "RSVP_ITEM",
            entityId: itemId,
            changes: { campaignId, before: item, after: d },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-items:audit-failed"));

      return NextResponse.json({ item: updated });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-items:update-failed");
    return NextResponse.json({ error: "Failed to update item" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const route = "DELETE /events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]";
  try {
    const [session, { eventId, campaignId, itemId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]:DELETE" });
    if (denied) return denied;

    const event = await loadRsvpEvent(session.user, eventId);
    if (!event) {
      return apiErrorResponse(404, "Event not found", { route, eventId, userId: session.user.id });
    }

    return await runWithTenant(event.organizationId, async () => {
      const campaign = await loadRsvpCampaign(campaignId, eventId);
      if (!campaign) {
        return apiErrorResponse(404, "RSVP not found", {
          route, eventId, campaignId, userId: session.user.id,
        });
      }
      const item = await db.rsvpItem.findFirst({
        where: { id: itemId, campaignId },
        select: ITEM_SELECT,
      });
      if (!item) {
        return apiErrorResponse(404, "Item not found", {
          route, eventId, campaignId, itemId, userId: session.user.id,
        });
      }

      const { count } = await db.rsvpItem.deleteMany({ where: { id: itemId, campaignId } });
      if (count === 0) {
        return apiErrorResponse(404, "Item not found", {
          route, eventId, campaignId, itemId, userId: session.user.id,
        });
      }

      db.auditLog
        .create({
          data: {
            eventId,
            userId: session.user.id,
            action: "DELETE",
            entityType: "RSVP_ITEM",
            entityId: itemId,
            changes: { campaignId, deleted: item },
          },
        })
        .catch((err) => apiLogger.error({ err }, "rsvp-items:audit-failed"));

      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    apiLogger.error({ err }, "rsvp-items:delete-failed");
    return NextResponse.json({ error: "Failed to delete item" }, { status: 500 });
  }
}
