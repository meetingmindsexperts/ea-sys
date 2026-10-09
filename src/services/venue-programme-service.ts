/**
 * The event's programme for its online venue (docs/EVENT_BLUEPRINT_PLAN.md,
 * phase 6 step 4): the sessions the public agenda would show (scheduled, live
 * or completed; workshops and symposia count, break items do not) and the
 * sponsors, put in rooms and stand order by src/lib/venue/programme.ts. Read
 * by the venue page, the AI
 * attendees and the Venue tab. A failed read is logged and gives an empty
 * programme: the venue then shows its placeholders rather than not opening.
 * Never imports next/server.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { getSponsors } from "@/lib/sponsors";
import { BREAK_SESSION_TYPES } from "@/lib/session-enums";
import type { SponsorEntry } from "@/lib/webinar";
import { MAX_VENUE_SESSIONS, buildProgramme, type SessionInput, type VenueProgramme, type VenueRoomRef } from "@/lib/venue/programme";

interface Caller {
  organizationId: string;
  eventId: string;
}

export interface ProgrammeSources {
  sessions: SessionInput[];
  sponsors: SponsorEntry[];
}

/** The sessions and sponsors as stored. Throws; the callers decide what a failure means. */
async function readSources(caller: Caller): Promise<ProgrammeSources> {
  return runWithTenant(caller.organizationId, async () => {
    const [sessions, sponsors] = await Promise.all([
      db.eventSession.findMany({
        where: { eventId: caller.eventId, type: { notIn: BREAK_SESSION_TYPES }, status: { in: ["SCHEDULED", "LIVE", "COMPLETED"] } },
        select: { name: true, startTime: true, endTime: true, location: true, track: { select: { name: true } } },
        orderBy: { startTime: "asc" },
        take: MAX_VENUE_SESSIONS,
      }),
      getSponsors(caller.eventId),
    ]);
    return { sessions: sessions.map((s) => ({ ...s, track: s.track?.name ?? null })), sponsors };
  });
}

/** The programme as the venue shows it; empty (placeholders) when the read fails. */
export async function loadVenueProgramme(caller: Caller, rooms: VenueRoomRef[], tz: string): Promise<VenueProgramme> {
  try {
    const src = await readSources(caller);
    return buildProgramme(rooms, src.sessions, src.sponsors, tz);
  } catch (err) {
    apiLogger.error({ err, msg: "venue:programme-load-failed", eventId: caller.eventId });
    return { v: 1, tz, sessions: [], sponsors: [] };
  }
}

/**
 * For the Venue tab: each session's title, location and track, so the tab can
 * show which ones name no room while the rooms are edited, and the sponsor
 * count against the stands. Null when the read fails (the tab says so).
 */
export async function loadProgrammeSummary(caller: Caller): Promise<{ sessions: { title: string; location: string | null; track: string | null }[]; sponsors: number } | null> {
  try {
    const src = await readSources(caller);
    return { sessions: src.sessions.map((s) => ({ title: s.name, location: s.location, track: s.track })), sponsors: src.sponsors.length };
  } catch (err) {
    apiLogger.error({ err, msg: "venue:programme-summary-failed", eventId: caller.eventId });
    return null;
  }
}
