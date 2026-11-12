/**
 * A session's video stream, and whose it is (Nov 12, 2026;
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md, part A).
 *
 * THE one place that answers "what is this session's stream". Until now every
 * reader took the key from ZoomMeeting, the row of OUR Zoom webinar. A webinar
 * a partner produces on their own platform has no Zoom webinar of ours, so its
 * key lives on ExternalStream instead. Two sources, one answer:
 *
 *   external   an ExternalStream row exists for the session. While it exists it
 *              IS the session's stream, switched on or off: a partner's webinar
 *              must never fall back to a Zoom stream nobody is watching.
 *   zoom       else the session's Zoom meeting, when live streaming is on and
 *              it holds a key (the rule every reader applied before).
 *
 * Asked by stream-status, the attendee's join, the publish check, the room
 * route, the console, the stream watchdog and the overrun rule. NEVER read
 * `streamKey` from a table in a new place: a reader that knows only ZoomMeeting
 * shows a partner's webinar as "no stream", and one that knows only
 * ExternalStream breaks every Zoom webinar.
 *
 * What a source may DO differs and is the caller's question: only a Zoom
 * stream can be started, stopped or restarted by us (livestream.ts).
 */
import type { Prisma, StreamStatus } from "@prisma/client";
import { db } from "@/lib/db";

export type StreamSource = "zoom" | "external";

export interface SessionStream {
  source: StreamSource;
  /** The path the video arrives on and attendees watch on. A host credential: never sent to a viewer bare. */
  streamKey: string;
  streamStatus: StreamStatus;
}

interface ZoomStreamFields {
  liveStreamEnabled: boolean;
  streamKey: string | null;
  streamStatus: StreamStatus;
}

interface ExternalStreamFields {
  streamKey: string;
  streamStatus: StreamStatus;
}

const ZOOM_STREAM_SELECT = { liveStreamEnabled: true, streamKey: true, streamStatus: true } as const;
const EXTERNAL_STREAM_SELECT = { streamKey: true, streamStatus: true } as const;

/** The relations a reader that already loads the session selects, for pickSessionStream. */
export const SESSION_STREAM_SELECT = {
  zoomMeeting: { select: ZOOM_STREAM_SELECT },
  externalStream: { select: EXTERNAL_STREAM_SELECT },
} satisfies Prisma.EventSessionSelect;

/** Sessions that have a stream, as a filter on EventSession (the watchdog's scan). */
export const SESSION_HAS_STREAM: Prisma.EventSessionWhereInput = {
  OR: [
    { externalStream: { isNot: null } },
    { zoomMeeting: { is: { liveStreamEnabled: true, streamKey: { not: null } } } },
  ],
};

/** Pure: the stream of a session whose two possible rows are already loaded. */
export function pickSessionStream(row: {
  zoomMeeting?: ZoomStreamFields | null;
  externalStream?: ExternalStreamFields | null;
}): SessionStream | null {
  if (row.externalStream) {
    return { source: "external", streamKey: row.externalStream.streamKey, streamStatus: row.externalStream.streamStatus };
  }
  const zoom = row.zoomMeeting;
  if (!zoom?.liveStreamEnabled || !zoom.streamKey) return null;
  return { source: "zoom", streamKey: zoom.streamKey, streamStatus: zoom.streamStatus };
}

/**
 * The session's stream, or null for none. Both rows are bound to the event, so
 * a session id from another event finds nothing. Runs in the caller's tenant.
 */
export async function sessionStream(sessionId: string, eventId: string): Promise<SessionStream | null> {
  const [externalStream, zoomMeeting] = await Promise.all([
    db.externalStream.findFirst({ where: { sessionId, eventId }, select: EXTERNAL_STREAM_SELECT }),
    db.zoomMeeting.findFirst({ where: { sessionId, eventId }, select: ZOOM_STREAM_SELECT }),
  ]);
  return pickSessionStream({ externalStream, zoomMeeting });
}

/**
 * sessionStream for the ONE hot caller, stream-status: every waiting or
 * recovering player polls it about every 10 seconds, so 5,000 viewers after a
 * drop are 500 requests a second, each of which would otherwise read both
 * tables (review of 12c4c8b8: the resolver made that two reads where there was
 * one). Per container, a few seconds, like the probe and the room caches
 * beside it. "No stream" is cached too: a session without one is polled just
 * as hard.
 *
 * Only for a reader that can be a few seconds late. Anything that ACTS on the
 * answer (the room route, the publish check, the watchdog) asks sessionStream.
 */
const streamCache = new Map<string, { stream: SessionStream | null; at: number }>();
const STREAM_CACHE_TTL_MS = 3000;
const STREAM_CACHE_MAX = 5000;

/** Test hook. */
export function resetSessionStreamCache(): void {
  streamCache.clear();
}

export async function cachedSessionStream(sessionId: string, eventId: string): Promise<SessionStream | null> {
  const key = `${eventId}:${sessionId}`;
  const cached = streamCache.get(key);
  if (cached && Date.now() - cached.at < STREAM_CACHE_TTL_MS) return cached.stream;
  const stream = await sessionStream(sessionId, eventId);
  if (streamCache.size >= STREAM_CACHE_MAX) streamCache.clear();
  streamCache.set(key, { stream, at: Date.now() });
  return stream;
}

/** Whose key this is, for the publish check, which is handed a key and nothing else. */
export type StreamKeyOwner =
  | { source: "zoom"; eventId: string; sessionId: string }
  | {
      source: "external";
      id: string;
      eventId: string;
      sessionId: string;
      secretVersion: number;
      /** When the key was last replaced, or null for never. */
      keyReplacedAt: Date | null;
      enabled: boolean;
      validFrom: Date;
      /** Null follows the session: see externalStreamValidUntil. */
      validUntil: Date | null;
      sessionEndTime: Date;
    };

/** How long after the session's scheduled end a key without its own end date still works. */
export const EXTERNAL_STREAM_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * When an external key stops working: its own end date, else 24 hours after the
 * session's scheduled end AS IT IS NOW. Derived, never stored, so moving the
 * webinar's date moves the period with it and no retime path has to remember.
 */
export function externalStreamValidUntil(stream: { validUntil: Date | null; sessionEndTime: Date }): Date {
  return stream.validUntil ?? new Date(stream.sessionEndTime.getTime() + EXTERNAL_STREAM_GRACE_MS);
}

/**
 * The stream a key belongs to, or null. A Zoom key counts only while live
 * streaming is on, as before. An external key is returned whatever its state:
 * whether it may publish NOW (switched on, inside its period, the right
 * password) is the publish check's decision, so each refusal can say why.
 */
export async function streamKeyOwner(streamKey: string): Promise<StreamKeyOwner | null> {
  const [external, zoom] = await Promise.all([
    db.externalStream.findFirst({
      where: { streamKey },
      select: {
        id: true,
        eventId: true,
        sessionId: true,
        secretVersion: true,
        keyReplacedAt: true,
        enabled: true,
        validFrom: true,
        validUntil: true,
        session: { select: { endTime: true } },
      },
    }),
    db.zoomMeeting.findFirst({
      where: { streamKey, liveStreamEnabled: true },
      select: { eventId: true, sessionId: true },
    }),
  ]);
  if (external) {
    const { session, ...own } = external;
    return { source: "external", ...own, sessionEndTime: session.endTime };
  }
  return zoom ? { source: "zoom", eventId: zoom.eventId, sessionId: zoom.sessionId } : null;
}

/**
 * Write what the probe found onto the stream's own row. The event binding is
 * load-bearing: stream-status is a PUBLIC route, and without it a crafted
 * session id would flip the status on another organisation's row.
 * `organizationId` self-heals rows from before the column was stamped.
 */
export async function setSessionStreamStatus(
  stream: SessionStream,
  at: { sessionId: string; eventId: string; organizationId: string },
  status: StreamStatus,
): Promise<void> {
  // Keep the cached answer in step BEFORE the write is awaited, so the requests
  // arriving in the next few seconds see the new status and do not each write it again.
  const cached = streamCache.get(`${at.eventId}:${at.sessionId}`);
  if (cached?.stream) cached.stream = { ...cached.stream, streamStatus: status };
  const data = { streamStatus: status, organizationId: at.organizationId };
  if (stream.source === "external") {
    await db.externalStream.updateMany({ where: { sessionId: at.sessionId, eventId: at.eventId }, data });
    return;
  }
  await db.zoomMeeting.updateMany({
    where: { sessionId: at.sessionId, eventId: at.eventId, liveStreamEnabled: true },
    data,
  });
}

/**
 * Where a viewer's player fetches the stream. HLS is served by CloudFront
 * (HLS_CDN_BASE) with the box as the player's one fallback; unset, both are the
 * app's own address (a single box, local development).
 */
export function hlsPlaybackUrls(streamKey: string): { hlsUrl: string; hlsOriginUrl: string } {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const cdnBase = process.env.HLS_CDN_BASE || appUrl;
  const path = `/stream/live/${streamKey}/index.m3u8`;
  return { hlsUrl: `${cdnBase}${path}`, hlsOriginUrl: `${appUrl}${path}` };
}
