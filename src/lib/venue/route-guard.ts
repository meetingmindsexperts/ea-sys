/**
 * The one gate the venue page (`/e/<slug>/venue`) and every
 * `/api/venue/<eventId>/*` handler pass through (plan phase 4, staff preview):
 *
 *   1. a signed-in session (401) on an organisation (403);
 *   2. `events.read` on THIS event, the lookup going through the permission's
 *      own where (a 404 when the person cannot see it);
 *   3. the event's slug is in VENUE_EVENT_SLUGS (404 otherwise: a venue that is
 *      not switched on does not announce itself);
 *   4. for the event team's views (everyone's activity, reports, settings):
 *      `events.update` on the event, else 403.
 *
 * Registered with both route gates (it calls auth() and requirePermission()).
 */
import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isVenueEnabledFor } from "@/lib/module-flags";
import { requireOrgId } from "@/lib/require-org";
import { runWithTenant } from "@/lib/tenant-context";
import { can } from "@/lib/permissions/can";
import { principalFromSession, requirePermission } from "@/lib/permissions/require-permission";

export interface VenueEvent {
  id: string;
  slug: string;
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  timezone: string;
  eventType: string | null;
  settings: unknown;
  organizationId: string;
}

export type VenueGate =
  | { ok: true; session: Session; organizationId: string; userId: string; event: VenueEvent; team: boolean }
  | { ok: false; response: NextResponse };

const EVENT_SELECT = {
  id: true,
  slug: true,
  name: true,
  startDate: true,
  endDate: true,
  venue: true,
  timezone: true,
  eventType: true,
  settings: true,
  organizationId: true,
} as const;

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** `by` is the event id (API routes) or its slug (the page). */
export async function venueGuard(by: { id: string } | { slug: string }, route: string, opts: { team?: boolean } = {}): Promise<VenueGate> {
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: `${route}:unauthorized` });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const org = requireOrgId(session, { route });
  if ("error" in org) return { ok: false, response: org.error };

  return runWithTenant(org.orgId, async () => {
    const eventId =
      "id" in by
        ? by.id
        : (await db.event.findFirst({ where: { organizationId: org.orgId, slug: by.slug }, select: { id: true } }))?.id;
    if (!eventId) {
      apiLogger.warn({ msg: `${route}:event-not-found`, userId: session.user.id, ...by });
      return { ok: false as const, response: notFound() };
    }
    const gate = requirePermission(session, "events.read", { route, eventId });
    if (!gate.ok) return { ok: false as const, response: gate.response };
    // The caller's own assignment row only: an ASSIGNED-scope grant asks whether they are on this event (review L3).
    const row = await db.event.findFirst({ where: gate.eventWhere, select: { ...EVENT_SELECT, staffAssignments: { where: { userId: session.user.id }, select: { userId: true } } } });
    if (!row || !row.organizationId) {
      apiLogger.warn({ msg: `${route}:event-not-visible`, userId: session.user.id, eventId });
      return { ok: false as const, response: notFound() };
    }
    const { staffAssignments, ...event } = row;
    if (!isVenueEnabledFor(event.slug)) {
      apiLogger.warn({ msg: `${route}:venue-not-enabled`, userId: session.user.id, eventId, slug: event.slug });
      return { ok: false as const, response: notFound() };
    }
    const team = can(principalFromSession(session), "events.update", {
      event: { organizationId: event.organizationId, eventType: event.eventType ?? "", staffUserIds: staffAssignments.map((a) => a.userId) },
    });
    if (opts.team && !team) {
      apiLogger.warn({ msg: `${route}:not-event-team`, userId: session.user.id, eventId });
      return { ok: false as const, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return {
      ok: true as const,
      session,
      organizationId: event.organizationId,
      userId: session.user.id,
      event: event as VenueEvent,
      team,
    };
  });
}
