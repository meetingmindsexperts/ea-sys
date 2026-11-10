import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ownRegistrationWhere, type RegistrantScope } from "@/lib/registrant-access";
import { readWebinarSettings, webinarRecordingShown } from "@/lib/webinar";
import { sessionReplayKind, uploadedReplay } from "@/lib/webinar/replay";
import { viewerStandingWhere } from "@/lib/webinar/viewer-entitlement";

/**
 * A webinar's replay in a person's own portal (Nov 10, 2026): the Watch replay button on My events
 * and the page it opens, /my-account/replay/{eventId}.
 *
 * The replay lives here, and not only on the webinar's public page, because that page stops
 * answering once the organiser marks the event Completed, which they do within days. The portal
 * lists a person's events whatever their status, so a replay stays watchable for as long as the
 * organiser shows it.
 *
 * Never a new rule, three existing ones composed:
 *  - WHOSE registration: registrant-access.ts (ownRegistrationWhere), the portal's rule.
 *  - In good standing: viewer-entitlement.ts (confirmed, and paid or nothing owed), the rule for
 *    watching the webinar live.
 *  - WHICH replay: webinar/replay.ts (the organiser's switch, their uploaded replay, else Zoom's).
 *
 * Event columns ride on the registration read, as on My events: this file never queries Event
 * directly and always runs inside the portal's tenant lane (registrant-portal.ts).
 */

/** This person's registrations that may watch a webinar. */
function portalViewerWhere(scope: RegistrantScope): Prisma.RegistrationWhereInput {
  return { event: { eventType: "WEBINAR" }, AND: [ownRegistrationWhere(scope), viewerStandingWhere("WEBINAR")] };
}

const ANCHOR_FIELDS = {
  id: true,
  eventId: true,
  status: true,
  endTime: true,
  zoomMeeting: { select: { recordingStatus: true, recordingUrl: true, recordingPassword: true } },
} satisfies Prisma.EventSessionSelect;

/** The registrations among these that have a replay to watch now (their ids). */
export async function loadReplayFacts(
  scope: RegistrantScope,
  registrations: { id: string; event: { id: string; eventType: string | null } }[],
  now: Date,
): Promise<Set<string>> {
  const replays = new Set<string>();
  const webinarIds = [...new Set(registrations.filter((r) => r.event.eventType === "WEBINAR").map((r) => r.event.id))];
  if (webinarIds.length === 0) return replays;

  const entitled = await db.registration.findMany({
    where: { eventId: { in: webinarIds }, ...portalViewerWhere(scope) },
    select: { id: true, eventId: true, event: { select: { settings: true } } },
  });
  const settingsByEvent = new Map(entitled.map((r) => [r.eventId, r.event.settings]));
  const anchors = [...settingsByEvent].flatMap(([eventId, settings]) => {
    const sessionId = readWebinarSettings(settings)?.sessionId;
    return sessionId ? [{ eventId, settings, sessionId }] : [];
  });
  if (anchors.length === 0) return replays;

  const sessions = await db.eventSession.findMany({
    where: { id: { in: anchors.map((a) => a.sessionId) } },
    select: ANCHOR_FIELDS,
  });
  const eventsWithReplay = new Set<string>();
  for (const { eventId, settings, sessionId } of anchors) {
    // The anchor is bound to its own event: a stale pointer never borrows another event's session.
    const session = sessions.find((s) => s.id === sessionId && s.eventId === eventId);
    if (!session) continue;
    const kind = sessionReplayKind({
      eventType: "WEBINAR",
      settings,
      session,
      recordingStatus: session.zoomMeeting?.recordingStatus,
      now,
    });
    if (kind) eventsWithReplay.add(eventId);
  }
  for (const r of entitled) if (eventsWithReplay.has(r.eventId)) replays.add(r.id);
  return replays;
}

export interface ReplayEvent {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
}

export type PortalReplay =
  /** No registration of this person's may watch this webinar. Nothing about the event is told. */
  | { state: "not-registered" }
  /** Nothing to play. `expected`: the organiser has switched the recording on, so one is coming. */
  | { state: "none"; event: ReplayEvent; expected: boolean }
  /** The organiser's uploaded replay, played in the page. */
  | { state: "embed"; event: ReplayEvent; embedUrl: string }
  /** Zoom's cloud recording, opened on Zoom with its passcode. */
  | { state: "zoom"; event: ReplayEvent; url: string; password: string | null };

/** What /my-account/replay/{eventId} shows this person. */
export async function loadPortalReplay(scope: RegistrantScope, eventId: string, now: Date): Promise<PortalReplay> {
  const registration = await db.registration.findFirst({
    where: { eventId, ...portalViewerWhere(scope) },
    select: {
      id: true,
      event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, timezone: true, settings: true } },
    },
  });
  if (!registration) return { state: "not-registered" };

  const { settings, ...event } = registration.event;
  const none: PortalReplay = { state: "none", event, expected: webinarRecordingShown(settings) };
  const sessionId = readWebinarSettings(settings)?.sessionId;
  if (!sessionId) return none;
  const session = await db.eventSession.findFirst({ where: { id: sessionId, eventId }, select: ANCHOR_FIELDS });
  if (!session) return none;

  const question = { eventType: "WEBINAR", settings, session, now };
  const kind = sessionReplayKind({ ...question, recordingStatus: session.zoomMeeting?.recordingStatus });
  const uploaded = kind === "embed" ? uploadedReplay(question) : null;
  if (uploaded) return { state: "embed", event, embedUrl: uploaded.embedUrl };
  if (kind === "zoom" && session.zoomMeeting?.recordingUrl) {
    return { state: "zoom", event, url: session.zoomMeeting.recordingUrl, password: session.zoomMeeting.recordingPassword };
  }
  return none;
}
