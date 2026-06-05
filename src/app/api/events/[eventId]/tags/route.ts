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
 * Auth: same as the other event-scoped admin routes. denyReviewer +
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
import { buildEventAccessWhere } from "@/lib/event-access";
import { denyReviewer } from "@/lib/auth-guards";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;

    // Event-access check first. Returns 404 instead of 403 on a foreign
    // event id to avoid an enumeration oracle.
    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
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
    const registrations = await db.registration.findMany({
      where: { eventId, status: { notIn: ["CANCELLED"] } },
      select: { attendee: { select: { tags: true } } },
    });

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
