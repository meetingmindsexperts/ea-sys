/**
 * RSVP — server-only lookup helpers shared by the organizer routes.
 *
 * Every organizer route needs the same two steps: resolve the event through
 * `buildEventAccessWhere` (so an org-null SUPER_ADMIN and an assignment-scoped
 * ONSITE both behave), then bind the campaign to that event. Six routes need
 * it, so it lives here rather than being retyped per route — a hand-copied
 * scoping check is exactly how one of them ends up org-scoped-only.
 *
 * Docs: docs/RSVP.md.
 */
import { db } from "@/lib/db";
import { buildEventAccessWhere } from "@/lib/event-access";
import type { Session } from "next-auth";

export interface RsvpEventRef {
  id: string;
  organizationId: string;
}

/**
 * The event, scoped to what this user may reach. Returns null (→ 404, never
 * 403) so a foreign eventId is not an existence oracle.
 */
export async function loadRsvpEvent(
  user: Session["user"],
  eventId: string,
): Promise<RsvpEventRef | null> {
  const event = await db.event.findFirst({
    where: buildEventAccessWhere(user, eventId),
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
