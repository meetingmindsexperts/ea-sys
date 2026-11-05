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
 */
import { db } from "@/lib/db";
import { readWebinarSettings } from "@/lib/webinar";
import { isStreamArriving } from "@/lib/webinar/stream-probe";

/** Past this after the scheduled end, the room closes and the thank-you goes, stream or not. Matches the
 *  window in which a close still counts as the webinar's end (CLOSE_COUNTS_UNTIL_MS). */
export const OVERRUN_HARD_CAP_MS = 6 * 60 * 60 * 1000;

/** Whether this webinar's room is still receiving its own HLS stream. False for Zoom embed mode. */
export async function isWebinarStreamArriving(args: {
  eventId: string;
  sessionId: string;
  eventSettings: unknown;
}): Promise<boolean> {
  if (readWebinarSettings(args.eventSettings)?.viewingMode !== "hls") return false;
  const meeting = await db.zoomMeeting.findFirst({
    where: { sessionId: args.sessionId, eventId: args.eventId },
    select: { liveStreamEnabled: true, streamKey: true },
  });
  if (!meeting?.liveStreamEnabled || !meeting.streamKey) return false;
  return isStreamArriving(meeting.streamKey, { fresh: true });
}
