/**
 * Stream watchdog (Nov 5, 2026): restarts Zoom's push when a live webinar's
 * custom stream drops while the room is open.
 *
 * On the Nov 5 test webinar Zoom's push stopped at 08:42:03 UTC and stayed
 * down until a producer noticed and pressed Start stream, 35 seconds later.
 * Attendees' players recover by themselves once the stream is back; nothing
 * brought it back. This does what that producer did:
 *
 *   1. Every minute (worker job webinar-stream-watchdog), each open room in
 *      Custom stream mode is checked against MediaMTX.
 *   2. Missing twice, CONFIRM_DELAY_MS apart, after having been live: a drop.
 *      It is logged at warn (so it shows on /logs) and on the timeline.
 *   3. Zoom is asked to start the push again, the same call as the console's
 *      Start stream button. At most MAX_AUTO_RESTARTS per drop, each wait
 *      doubling from a minute. Zoom refuses when the host has ended the
 *      webinar, so a finished webinar is never restarted.
 *
 * Never acts on: a stream that was never live in this room (opening the room
 * already asks Zoom to start it; the producer's toast says why it failed), a
 * stream the producer stopped on purpose (settings.webinar.streamStoppedAt),
 * Zoom embed mode, or a closed room.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { controlWebinarLiveStream } from "@/lib/webinar/livestream";
import { isStreamArriving } from "@/lib/webinar/stream-probe";
import { lastStreamObservation, recordStreamEvent } from "@/lib/webinar/stream-timeline";

/** A second look this long after the first miss, so a sub-30-second RTMP reconnect is not a drop. */
export const CONFIRM_DELAY_MS = 30_000;
export const MAX_AUTO_RESTARTS = 5;
const RESTART_BACKOFF_BASE_MS = 60_000;
export const MAX_ROOMS_PER_TICK = 20;

interface StreamState {
  /** Last state written to the timeline: up, down, or unknown (this process has not seen it yet). */
  up: boolean | null;
  restarts: number;
  nextRestartAt: number;
}

/** Per stream key, in the worker process. A restart forgets it and re-reads the timeline. */
const states = new Map<string, StreamState>();

/** Test hook. */
export function resetStreamWatchdog(): void {
  states.clear();
}

interface WatchedRoom {
  sessionId: string;
  sessionName: string;
  eventId: string;
  eventSlug: string;
  organizationId: string;
  streamKey: string;
  roomOpenedAt: Date | null;
}

export interface WatchdogReport {
  checked: number;
  dropped: number;
  restartsRequested: number;
}

async function findOpenStreamRooms(): Promise<WatchedRoom[]> {
  // Privileged lane: a cross-tenant scan for open rooms; each room's work then runs in its own tenant.
  const rows = await dbOperator.eventSession.findMany({
    where: {
      status: "LIVE",
      event: { eventType: "WEBINAR" },
      zoomMeeting: { is: { liveStreamEnabled: true, streamKey: { not: null } } },
    },
    take: MAX_ROOMS_PER_TICK,
    select: {
      id: true,
      name: true,
      eventId: true,
      event: { select: { organizationId: true, slug: true, settings: true } },
      zoomMeeting: { select: { streamKey: true } },
    },
  });
  const rooms: WatchedRoom[] = [];
  for (const row of rows) {
    const webinar = readWebinarSettings(row.event.settings);
    // Only the anchor session in Custom stream mode, and not one the producer stopped on purpose.
    if (webinar?.sessionId !== row.id || webinar.viewingMode !== "hls" || !row.zoomMeeting?.streamKey) continue;
    if (webinar.streamStoppedAt) continue;
    const opened = webinar.roomOpenedAt ? new Date(webinar.roomOpenedAt) : null;
    rooms.push({
      sessionId: row.id,
      sessionName: row.name,
      eventId: row.eventId,
      eventSlug: row.event.slug,
      organizationId: row.event.organizationId,
      streamKey: row.zoomMeeting.streamKey,
      roomOpenedAt: opened && !Number.isNaN(opened.getTime()) ? opened : null,
    });
  }
  return rooms;
}

async function stateFor(room: WatchedRoom): Promise<StreamState> {
  const known = states.get(room.streamKey);
  if (known) return known;
  const last = await lastStreamObservation(room.eventId, room.sessionId, room.roomOpenedAt);
  const state: StreamState = { up: last === null ? null : last === "up", restarts: 0, nextRestartAt: 0 };
  states.set(room.streamKey, state);
  return state;
}

async function onArriving(room: WatchedRoom, state: StreamState): Promise<void> {
  if (state.up !== true) {
    const restored = state.up === false;
    await recordStreamEvent({
      organizationId: room.organizationId,
      eventId: room.eventId,
      sessionId: room.sessionId,
      kind: "STREAM_LIVE",
      detail: restored ? "Back after a drop" : null,
      source: "worker",
    });
    if (restored) {
      apiLogger.info({ eventId: room.eventId, sessionId: room.sessionId, restarts: state.restarts }, "webinar-stream:restored");
    }
  }
  state.up = true;
  state.restarts = 0;
  state.nextRestartAt = 0;
}

async function onMissing(room: WatchedRoom, state: StreamState, now: number, report: WatchdogReport): Promise<void> {
  // Never live in this room: not a drop, and nothing to bring back.
  if (state.up === null) return;
  if (state.up === true) {
    state.up = false;
    report.dropped += 1;
    apiLogger.warn({ eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:dropped-while-live");
    await recordStreamEvent({
      organizationId: room.organizationId,
      eventId: room.eventId,
      sessionId: room.sessionId,
      kind: "STREAM_DROPPED",
      source: "worker",
    });
  }
  if (state.restarts >= MAX_AUTO_RESTARTS || now < state.nextRestartAt) return;

  state.restarts += 1;
  state.nextRestartAt = now + RESTART_BACKOFF_BASE_MS * 2 ** (state.restarts - 1);
  report.restartsRequested += 1;
  const result = await controlWebinarLiveStream({
    organizationId: room.organizationId,
    eventId: room.eventId,
    eventSlug: room.eventSlug,
    sessionId: room.sessionId,
    sessionName: room.sessionName,
    action: "start",
    userId: "stream-watchdog",
  });
  if (result.ok) {
    apiLogger.info({ eventId: room.eventId, sessionId: room.sessionId, attempt: state.restarts }, "webinar-stream:auto-restart-requested");
  } else {
    apiLogger.warn(
      { eventId: room.eventId, sessionId: room.sessionId, attempt: state.restarts, code: result.code },
      "webinar-stream:auto-restart-failed",
    );
  }
  await recordStreamEvent({
    organizationId: room.organizationId,
    eventId: room.eventId,
    sessionId: room.sessionId,
    kind: result.ok ? "AUTO_RESTART_REQUESTED" : "AUTO_RESTART_FAILED",
    detail: result.ok ? `Attempt ${state.restarts} of ${MAX_AUTO_RESTARTS}` : result.message,
    source: "worker",
  });
  if (!result.ok && state.restarts >= MAX_AUTO_RESTARTS) {
    apiLogger.warn({ eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:auto-restart-gave-up");
  }
}

export async function runStreamWatchdogTick(
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WatchdogReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report: WatchdogReport = { checked: 0, dropped: 0, restartsRequested: 0 };

  const rooms = await findOpenStreamRooms();
  // Forget streams whose room is no longer open (closed, or stopped by the producer).
  const live = new Set(rooms.map((r) => r.streamKey));
  for (const key of states.keys()) if (!live.has(key)) states.delete(key);
  if (rooms.length === 0) return report;

  const first = await Promise.all(rooms.map((r) => isStreamArriving(r.streamKey, { fresh: true })));
  const missing = rooms.filter((_, i) => !first[i]);
  // One shared wait for the second look, so a tick lasts about CONFIRM_DELAY_MS however many rooms.
  if (missing.length > 0) await sleep(CONFIRM_DELAY_MS);
  const second = new Map<string, boolean>();
  await Promise.all(missing.map(async (r) => second.set(r.streamKey, await isStreamArriving(r.streamKey, { fresh: true }))));

  for (const room of rooms) {
    report.checked += 1;
    try {
      await runWithTenant(room.organizationId, async () => {
        const state = await stateFor(room);
        const arriving = second.has(room.streamKey) ? second.get(room.streamKey)! : true;
        if (arriving) await onArriving(room, state);
        else await onMissing(room, state, now(), report);
      });
    } catch (err) {
      apiLogger.error({ err, eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:watchdog-room-failed");
    }
  }
  return report;
}
