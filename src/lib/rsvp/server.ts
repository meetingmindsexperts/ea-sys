/**
 * RSVP — server-only lookup helpers shared by the organizer routes.
 *
 * Every organizer route needs the same two steps: resolve the event through
 * the route's `gate.eventWhere` (from `requirePermission`, so the lookup comes
 * from the grant that let the caller in), then bind the campaign to that event. Six routes need
 * it, so it lives here rather than being retyped per route — a hand-copied
 * scoping check is exactly how one of them ends up org-scoped-only.
 *
 * Docs: docs/RSVP.md.
 */
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export interface RsvpEventRef {
  id: string;
  organizationId: string;
}

/**
 * The event, scoped by the caller's `gate.eventWhere`. Returns null (→ 404, never
 * 403) so a foreign eventId is not an existence oracle.
 */
export async function loadRsvpEvent(eventWhere: Prisma.EventWhereInput): Promise<RsvpEventRef | null> {
  const event = await db.event.findFirst({
    where: eventWhere,
    select: { id: true, organizationId: true },
  });
  return event as RsvpEventRef | null;
}

/**
 * A campaign bound to its event. The `eventId` in the where is what stops a
 * campaign id from one event resolving against another event's URL — call
 * this INSIDE the tenant lane.
 */
export async function loadRsvpCampaign(campaignId: string, eventId: string) {
  return db.rsvpCampaign.findFirst({
    where: { id: campaignId, eventId },
    select: {
      id: true,
      eventId: true,
      organizationId: true,
      name: true,
      description: true,
      selectionMode: true,
      allowGuests: true,
      collectDietary: true,
      isActive: true,
      sortOrder: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export type RsvpCampaignRow = NonNullable<Awaited<ReturnType<typeof loadRsvpCampaign>>>;
