/**
 * GET /api/events/[eventId]/speakers/tags
 *
 * Aggregated tag list for an event's speakers. Mirror of the
 * registrations/tags route but reads from Speaker.tags instead of
 * Attendee.tags via Registration.
 *
 * Used by the autocomplete dropdown in the TagInput component on the
 * speaker detail sheet + Add Speaker form to prevent operator-typed
 * duplicates like "VIP" vs "vip" — the dropdown shows existing tags
 * as they type so they pick one rather than creating a fresh row.
 *
 * Returns { tags: [{ tag, count }] } sorted by count desc, then by
 * tag name asc.
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

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({
        msg: "speaker-tags:event-not-found",
        eventId,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const speakers = await db.speaker.findMany({
      where: { eventId },
      select: { tags: true },
    });

    const counts = new Map<string, number>();
    for (const r of speakers) {
      for (const raw of r.tags ?? []) {
        if (typeof raw !== "string") continue;
        const tag = raw.trim();
        if (tag === "") continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    const tags = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    return NextResponse.json({ tags });
  } catch (err) {
    apiLogger.error({ err, msg: "speaker-tags:unhandled" });
    return NextResponse.json(
      { error: "Failed to load speaker tags" },
      { status: 500 },
    );
  }
}
