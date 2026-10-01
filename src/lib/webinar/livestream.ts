/**
 * Custom-stream control for a webinar session: the one place that tells Zoom
 * where to push the stream (sync) and when to push it (start / stop).
 *
 * Why it exists (Oct 1, 2026): the app configured Zoom's custom live stream
 * only at the moment a Zoom meeting was created, and never started it. A host
 * had to find "Live on Custom Live Streaming Service" in Zoom by hand, the
 * console card claimed Zoom streams automatically, and a session created
 * without streaming could only gain it by deleting and recreating the
 * meeting. Called by the producer's Start / Stop / Re-send controls
 * (`POST /api/events/[eventId]/webinar/livestream`) and by the room toggle,
 * which starts the stream when the room opens in custom-stream mode.
 *
 * Errors are values; this never imports next/server.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { zoomApiRequest } from "@/lib/zoom/client";
import { enableWebinarLiveStreaming, enableZoomLiveStreaming } from "@/lib/zoom/meetings";

export type LiveStreamAction = "sync" | "start" | "stop";

export type LiveStreamResult =
  | { ok: true; action: LiveStreamAction; streamKey: string }
  | {
      ok: false;
      code: "NO_ZOOM_MEETING" | "STREAM_NOT_CONFIGURED" | "ZOOM_API_FAILED";
      message: string;
    };

/**
 * The RTMP address Zoom pushes to. The single source for both the value sent
 * to Zoom and the one shown to the producer; the card used to build its own
 * from the browser's hostname, which could disagree with `RTMP_INGEST_URL`.
 */
export function rtmpIngestUrl(): string {
  return (
    process.env.RTMP_INGEST_URL ||
    `rtmp://${new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost").hostname}:1935/live/`
  );
}

export function newStreamKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function zoomPath(meetingType: string, zoomMeetingId: string): string {
  return meetingType === "MEETING" ? `/meetings/${zoomMeetingId}` : `/webinars/${zoomMeetingId}`;
}

/**
 * Zoom's answer to "start" before the host has started the webinar is a
 * refusal; say so in words a producer can act on.
 */
export function zoomMessage(err: unknown, action: LiveStreamAction): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Zoom's 3001 is "meeting/webinar does not exist" (deleted or expired), not
  // "not started"; retrying Start can never fix it.
  if (/\(code: 3001\)/.test(raw)) {
    return "Zoom says this webinar no longer exists. Re-run the provisioner to create it again.";
  }
  if (action === "start" && /not started|has not started|not in progress|not running/i.test(raw)) {
    return "Zoom refused to start the stream: the webinar is not running yet. Start it as host in Zoom, then press Start stream again.";
  }
  return raw;
}

export async function controlWebinarLiveStream(input: {
  organizationId: string;
  eventId: string;
  eventSlug: string;
  sessionId: string;
  sessionName: string;
  action: LiveStreamAction;
  userId: string;
}): Promise<LiveStreamResult> {
  const { organizationId, eventId, eventSlug, sessionId, sessionName, action, userId } = input;
  const meeting = await db.zoomMeeting.findFirst({
    where: { sessionId, eventId },
    select: { id: true, zoomMeetingId: true, meetingType: true, liveStreamEnabled: true, streamKey: true },
  });
  if (!meeting) {
    apiLogger.warn({ eventId, sessionId, action }, "webinar-livestream:no-zoom-meeting");
    return { ok: false, code: "NO_ZOOM_MEETING", message: "This session has no Zoom webinar." };
  }

  const base = zoomPath(meeting.meetingType, meeting.zoomMeetingId);

  if (action === "sync") {
    // Keep an existing key: a key change mid-event would break a stream that
    // Zoom is already pushing under the old one.
    const streamKey = meeting.streamKey || newStreamKey();
    const pageUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/e/${eventSlug}/session/${sessionId}`;
    try {
      if (meeting.meetingType === "MEETING") {
        await enableZoomLiveStreaming(organizationId, meeting.zoomMeetingId, rtmpIngestUrl(), streamKey, pageUrl);
      } else {
        await enableWebinarLiveStreaming(organizationId, meeting.zoomMeetingId, rtmpIngestUrl(), streamKey, pageUrl);
      }
    } catch (err) {
      apiLogger.error({ err, eventId, sessionId }, "webinar-livestream:sync-failed");
      return { ok: false, code: "ZOOM_API_FAILED", message: zoomMessage(err, action) };
    }
    await db.zoomMeeting.update({
      where: { id: meeting.id },
      data: { liveStreamEnabled: true, streamKey },
    });
    apiLogger.info({ eventId, sessionId, userId, newKey: !meeting.streamKey }, "webinar-livestream:synced");
    return { ok: true, action, streamKey };
  }

  if (!meeting.liveStreamEnabled || !meeting.streamKey) {
    apiLogger.warn({ eventId, sessionId, action }, "webinar-livestream:not-configured");
    return {
      ok: false,
      code: "STREAM_NOT_CONFIGURED",
      message: "The custom stream is not set up on this session yet. Press Re-send stream settings to Zoom first.",
    };
  }

  try {
    await zoomApiRequest<void>(organizationId, "PATCH", `${base}/livestream/status`, {
      action,
      ...(action === "start"
        ? { settings: { active_speaker_name: false, display_name: sessionName.slice(0, 50) } }
        : {}),
    });
  } catch (err) {
    apiLogger.error({ err, eventId, sessionId, action }, "webinar-livestream:status-failed");
    return { ok: false, code: "ZOOM_API_FAILED", message: zoomMessage(err, action) };
  }
  apiLogger.info({ eventId, sessionId, userId, action }, "webinar-livestream:status-changed");
  return { ok: true, action, streamKey: meeting.streamKey };
}
