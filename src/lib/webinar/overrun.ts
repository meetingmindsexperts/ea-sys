/**
 * A webinar running long past its scheduled end (Nov 5, 2026).
 *
 * Two timers assume a room still open long after the scheduled end is a room
 * nobody closed: the auto-close safety net (two hours) and the thank-you hold
 * cap (two and a half hours). For a webinar that is genuinely still on air
 * that is wrong: attendees are cut off mid-session and thanked while watching.
 *
 * In Custom stream (HLS) mode there is a reliable answer: MediaMTX receives
 * the stream only while Zoom is broadcasting the webinar. So a room whose own
 * stream is still arriving is still on air, and both timers wait for it, up to
 * OVERRUN_HARD_CAP_MS after the scheduled end, which nothing outlasts. Zoom
 * embed mode has no such signal and keeps the plain timers; there the host
 * ending in Zoom closes the room (close-zoom-ended).
 *
 * Both callers run in the worker, which reaches MediaMTX through
 * MEDIAMTX_HLS_URL in docker-compose.prod.yml (review of fb4459d0: without it
 * every probe hit the worker's own localhost and this never fired).
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readWebinarSettings } from "@/lib/webinar";
import { isStreamArriving } from "@/lib/webinar/stream-probe";

/** Past this after the scheduled end, the room closes and the thank-you goes, stream or not. Matches the
 *  window in which a close still counts as the webinar's end (CLOSE_COUNTS_UNTIL_MS). */
export const OVERRUN_HARD_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * How long the stream must be missing before the webinar counts as off air. One missed probe is not
 * the end: Zoom's RTMP push drops and reconnects (40 s on Nov 5, 2026), and MediaMTX removes the path
 * meanwhile. Ending on a blip would close the room on everyone and send a thank-you that cannot be
 * recalled (review of fb4459d0).
 */
export const STREAM_ABSENCE_GRACE_MS = 5 * 60 * 1000;

/** When each stream was first seen missing, in this process (the worker). Cleared when it is seen again.
 *  A restart forgets it, which only restarts the grace: it can delay an end, never cause one. */
const missingSince = new Map<string, number>();

/** Test hook: forget every recorded absence. */
export function resetStreamAbsence(): void {
  missingSince.clear();
}

/**
 * Whether this webinar is still streaming: its own HLS stream is arriving, or has been missing for less
 * than STREAM_ABSENCE_GRACE_MS. False for Zoom embed mode or a session without a configured stream.
 */
export async function isWebinarStreamArriving(args: {
  eventId: string;
  sessionId: string;
  eventSettings: unknown;
  now?: number;
}): Promise<boolean> {
  if (readWebinarSettings(args.eventSettings)?.viewingMode !== "hls") return false;
  const meeting = await db.zoomMeeting.findFirst({
    where: { sessionId: args.sessionId, eventId: args.eventId },
    select: { liveStreamEnabled: true, streamKey: true },
  });
  if (!meeting?.liveStreamEnabled || !meeting.streamKey) return false;

  const key = meeting.streamKey;
  const now = args.now ?? Date.now();
  if (await isStreamArriving(key, { fresh: true })) {
    missingSince.delete(key);
    return true;
  }
  const since = missingSince.get(key);
  if (since === undefined) {
    missingSince.set(key, now);
    apiLogger.info({ eventId: args.eventId, sessionId: args.sessionId }, "webinar-overrun:stream-missing-grace-started");
    return true;
  }
  if (now - since < STREAM_ABSENCE_GRACE_MS) return true;
  apiLogger.info(
    { eventId: args.eventId, sessionId: args.sessionId, missingMs: now - since },
    "webinar-overrun:stream-gone",
  );
  return false;
}
