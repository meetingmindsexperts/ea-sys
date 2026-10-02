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
import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * The publish password for a stream key (final review, Oct 2, 2026). The bare
 * key is also the HLS read path that every registered viewer receives, so on
 * its own it cannot authorise a publish: a viewer could push their own video
 * over Zoom's. Zoom is given `key?user=publisher&pass=<this>` (MediaMTX's
 * standard way to pass publish credentials on RTMP); the auth webhook checks
 * it; viewers never see it. Derived, not stored, so there is no new column
 * and no key to rotate separately.
 */
export const STREAM_PUBLISH_USER = "publisher";

export function streamPublishPassword(streamKey: string): string {
  const secret = process.env.STREAM_PUBLISH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("STREAM_PUBLISH_SECRET or NEXTAUTH_SECRET must be set to sign stream publishes");
  return createHmac("sha256", secret).update(`stream-publish:${streamKey}`).digest("hex").slice(0, 40);
}

/** What Zoom is told to push to after the RTMP address: key plus credentials. */
export function zoomPublishKey(streamKey: string): string {
  return `${streamKey}?user=${STREAM_PUBLISH_USER}&pass=${streamPublishPassword(streamKey)}`;
}

/** Constant-time check of a publish password presented to MediaMTX. */
export function isValidPublishPassword(streamKey: string, presented: string | undefined | null): boolean {
  if (!presented) return false;
  const expected = Buffer.from(streamPublishPassword(streamKey));
  const given = Buffer.from(presented);
  return expected.length === given.length && timingSafeEqual(expected, given);
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
  // Zoom takes one start request per 30 seconds; a second one inside that
  // window gets 429 even though the first may still be starting the stream.
  if (/Zoom API error: 429\b/.test(raw)) {
    return "Zoom is still handling the previous start request (it accepts one every 30 seconds). Wait half a minute and check the attendee page before pressing Start stream again.";
  }
  if (/not started|has not started|not in progress|not running/i.test(raw)) {
    return action === "stop"
      ? "There is no stream to stop: the webinar is not live in Zoom."
      : "Zoom refused to start the stream: the webinar is not live in Zoom yet. Start it as host, and if Zoom shows a practice session, click Start Webinar to go live, then press Start stream again.";
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
        await enableZoomLiveStreaming(organizationId, meeting.zoomMeetingId, rtmpIngestUrl(), zoomPublishKey(streamKey), pageUrl);
      } else {
        await enableWebinarLiveStreaming(organizationId, meeting.zoomMeetingId, rtmpIngestUrl(), zoomPublishKey(streamKey), pageUrl);
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
