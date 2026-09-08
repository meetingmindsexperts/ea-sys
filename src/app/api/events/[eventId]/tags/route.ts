/**
 * GET /api/events/[eventId]/tags
 *
 * Returns the deduplicated list of tags currently in use on Attendees
 * registered for this event, with per-tag counts.
 *
 * Response shape:
 *   { tags: [{ tag: string, count: number }] }
 *
 * Sort: descending by count, then ascending by tag name. Operators
 * scanning the dropdown should see "most-used first" so the common
 * filters (e.g. "checked-in", "vip", "survey-completed") rise to the
 * top.
 *
 * Auth: the registration-desk allow-list (MEMBER / ONSITE / WEBINARS opt
 * back in) + the DESK event surface, because the registrations list this
 * feeds is readable by exactly that population. denyReviewer +
 * org-scope check. MEMBER is allowed (read-only).
 *
 * Implementation: pulls Attendee.tags arrays for every non-cancelled
 * registration on the event, aggregates in-process. For ~5k
 * registrations × ~5 tags each this is a single ~250 KB pull + a
 * simple Map pass; no temporary table or jsonb operators required.
 * If event size grows past ~50k registrations and this gets slow, the
 * fix is a denormalized EventTag aggregate table populated by a
 * trigger (or a worker), NOT raw SQL — keep the route shape stable.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Desk allow-list (Sep 8, 2026): the registrations list this feeds is
    // readable by MEMBER / ONSITE / WEBINARS, and the rows carry their tags,
    // so the aggregate below discloses nothing those roles do not already see.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW, route: "tags:list", eventId });
    if (denied) return denied;

    // Event-access check first. Returns 404 instead of 403 on a foreign
    // event id to avoid an enumeration oracle.
    //
    // DESK surface (Sep 8, 2026): this feeds the registrations list's tag
    // filter, and that list resolves the event on the desk surface, so a
    // WEBINARS user opening a CONFERENCE's registrations saw the rows (tags
    // included, per row) while this call 404'd behind them. The payload is
    // tag names + counts, nothing the list does not already show.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId, { surface: "desk" }),
      // organizationId, not just id: the read below is on a POLICIED table and
      // needs the event's tenant lane. Event carries no policy, so resolving it
      // first works without one — which is exactly why this route (and the two
      // public ones fixed earlier) could look correct while returning nothing.
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "tags:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Fetch every non-cancelled registration's attendee tags. CHECKED_IN
    // is included — checked-in attendees are still part of the audience
    // operators might filter on (e.g. "send thank-you to all who checked
    // in"). CANCELLED is excluded because their tags are no longer
    // operationally relevant for any send action.
    const registrations = await runWithTenant(event.organizationId, () =>
      db.registration.findMany({
        where: { eventId, status: { notIn: ["CANCELLED"] } },
        select: { attendee: { select: { tags: true } } },
      }),
    );

    const counts = new Map<string, number>();
    for (const r of registrations) {
      const tags = r.attendee?.tags ?? [];
      for (const raw of tags) {
        if (typeof raw !== "string") continue;
        const tag = raw.trim();
        if (tag === "") continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      // Highest-count first; ties broken alphabetically so the order
      // stays stable across requests (Map iteration is insertion-order,
      // but counts can be equal and the dropdown should be deterministic).
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    return NextResponse.json({ tags });
  } catch (err) {
    apiLogger.error({ err, msg: "tags:unhandled" });
    return NextResponse.json(
      { error: "Failed to load tags" },
      { status: 500 },
    );
  }
}
