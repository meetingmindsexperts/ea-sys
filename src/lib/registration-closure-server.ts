/**
 * The server half of `registration-closure.ts`: loads a webinar's own session so the rule can ask
 * whether its room has ended. Call it inside the event's tenant lane (EventSession has a row
 * policy), as every caller already is.
 */
import { db } from "@/lib/db";
import { readWebinarSettings } from "@/lib/webinar";
import {
  registrationClosedReason,
  type AnchorSessionClock,
  type ClosureEvent,
  type RegistrationClosedReason,
} from "@/lib/registration-closure";

const CLOCK_SELECT = { id: true, eventId: true, status: true, startTime: true, endTime: true } as const;

/** The webinar's anchor session id, or null for any other event or a webinar without one. */
function anchorSessionId(event: { eventType: string | null | undefined; settings: unknown }): string | null {
  if (event.eventType !== "WEBINAR") return null;
  return readWebinarSettings(event.settings)?.sessionId ?? null;
}

/** The webinar's own session clock, or null (not a webinar, no session, or the session is gone). */
export async function loadAnchorSessionClock(
  event: { id: string; eventType: string | null | undefined; settings: unknown },
): Promise<AnchorSessionClock | null> {
  const sessionId = anchorSessionId(event);
  if (!sessionId) return null;
  return db.eventSession.findFirst({
    where: { id: sessionId, eventId: event.id },
    select: { status: true, startTime: true, endTime: true },
  });
}

/** Why this event's public registration is closed, or null when open. */
export async function loadRegistrationClosedReason(
  event: ClosureEvent & { id: string },
  now: Date = new Date(),
): Promise<RegistrationClosedReason | null> {
  return registrationClosedReason(event, await loadAnchorSessionClock(event), now);
}

/** The same for many events in one query (the catalogue). Keyed by event id. */
export async function loadRegistrationClosedReasons(
  events: ReadonlyArray<ClosureEvent & { id: string }>,
  now: Date = new Date(),
): Promise<Map<string, RegistrationClosedReason | null>> {
  const wanted = events.flatMap((e) => {
    const sessionId = anchorSessionId(e);
    return sessionId ? [{ eventId: e.id, sessionId }] : [];
  });
  const sessions = wanted.length
    ? await db.eventSession.findMany({ where: { id: { in: wanted.map((w) => w.sessionId) } }, select: CLOCK_SELECT })
    : [];
  // A session counts only for the event that names it (as the single lookup's eventId filter).
  const bySession = new Map(sessions.map((s) => [s.id, s]));
  return new Map(
    events.map((e) => {
      const sessionId = anchorSessionId(e);
      const session = sessionId ? bySession.get(sessionId) : undefined;
      const clock = session && session.eventId === e.id ? session : null;
      return [e.id, registrationClosedReason(e, clock, now)];
    }),
  );
}
