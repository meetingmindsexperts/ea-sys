/**
 * Which replay an attendee is offered for a session, and where it plays (Nov 10, 2026). ONE rule
 * for the public session page (the detail and recording routes), the webinar emails and their
 * previews, and the portal (registrant-replays.ts). A new surface asks here and never re-derives it.
 *
 *  - "embed": the organiser's uploaded replay (settings.webinar.replayUrl, a Vimeo link), played
 *    inside our registration-gated page. It wins over Zoom's recording: it does not expire.
 *  - "zoom": Zoom's cloud recording, opened on Zoom with its passcode.
 *
 * A webinar offers either only while the organiser's "Show the recording to attendees" switch is
 * on. Other event types have no switch and no uploaded replay: a session's Zoom recording shows
 * once fetched, as before.
 *
 * WHO may watch is not decided here: that is viewer-entitlement.ts, asked by the recording route.
 */
import { readWebinarSettings, webinarRecordingShown } from "@/lib/webinar";
import { parseReplayVideo, type ParsedReplayVideo } from "@/lib/webinar/replay-video";

export type ReplayKind = "embed" | "zoom";

export interface ReplaySession {
  id: string;
  status: string;
  endTime: Date;
}

interface ReplayQuestion {
  eventType: string | null | undefined;
  /** Event.settings. */
  settings: unknown;
  session: ReplaySession;
  now?: Date;
}

/** Over: closed by the producer, or past its scheduled end and not live now. */
function sessionOver(session: ReplaySession, now: Date): boolean {
  if (session.status === "COMPLETED") return true;
  return session.status !== "LIVE" && session.endTime.getTime() <= now.getTime();
}

/**
 * The organiser's uploaded replay for this session, or null. Only on the webinar's own (anchor)
 * session, and only once it is over: a link saved early must never replace the waiting room or
 * the live video with "Recording available". The stored link is parsed again here because other
 * writers can reach the settings JSON.
 */
export function uploadedReplay(q: ReplayQuestion): ParsedReplayVideo | null {
  if (q.eventType !== "WEBINAR") return null;
  const webinar = readWebinarSettings(q.settings);
  const video = parseReplayVideo(webinar?.replayUrl);
  if (!video) return null;
  if (webinar?.sessionId && webinar.sessionId !== q.session.id) return null;
  return sessionOver(q.session, q.now ?? new Date()) ? video : null;
}

/** The replay on offer for this session, or null for none. `recordingStatus` is its ZoomMeeting's. */
export function sessionReplayKind(q: ReplayQuestion & { recordingStatus: string | null | undefined }): ReplayKind | null {
  if (q.eventType === "WEBINAR" && !webinarRecordingShown(q.settings)) return null;
  if (uploadedReplay(q)) return "embed";
  return q.recordingStatus === "AVAILABLE" ? "zoom" : null;
}

/** A person's replay page for an event, in their own portal (registrant-replays.ts). */
export function replayPageUrl(appUrl: string, eventId: string): string {
  return `${appUrl}/my-account/replay/${eventId}`;
}

/**
 * The address a replay button in an EMAIL opens, or "" for none. An uploaded replay is never
 * linked directly: the email points at the person's replay page (replayPageUrl), which checks
 * their registration and plays it, and which keeps working after the event is marked Completed.
 * Zoom's recording keeps its own link, as before.
 */
export function replayEmailUrl(kind: ReplayKind | null, pageUrl: string, zoomUrl: string | null | undefined): string {
  if (kind === "embed") return pageUrl;
  if (kind === "zoom") return zoomUrl ?? "";
  return "";
}
