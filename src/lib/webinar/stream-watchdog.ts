/**
 * Stream watchdog (Nov 5, 2026): restarts Zoom's push when a live webinar's
 * custom stream drops while the room is open.
 *
 * On the Nov 5 test webinar Zoom's push stopped at 08:41:46 UTC (MediaMTX:
 * "[RTMP] closed: EOF", a clean hang-up from Zoom) and stayed down until a
 * producer pressed Start stream 52 seconds later. Attendees' players recover
 * by themselves once the stream is back; nothing brought it back. This does
 * what that producer did:
 *
 *   1. Every minute (worker job webinar-stream-watchdog), each open room in
 *      Custom stream mode is checked against MediaMTX.
 *   2. Absent (a 404, never a timeout or an unreachable MediaMTX) twice,
 *      CONFIRM_DELAY_MS apart, after having been live in this run: a drop.
 *      Logged at warn (so it shows on /logs) and put on the timeline.
 *   3. Just before acting, the room is read again: still open, not stopped by
 *      the producer, same run and stream key, no producer action since the
 *      tick began. Then Zoom is asked to start the push again, the same call
 *      as the console's Start stream button. At most MAX_AUTO_RESTARTS per
 *      drop, each wait doubling from a minute. Zoom answering "not running"
 *      (the host ended) stops the attempts for that drop at once.
 *
 * Never acts on: a stream never live in this run (opening the room already
 * asks Zoom to start it; the producer's toast says why it failed), a stream
 * the producer stopped (settings.webinar.streamStoppedAt), Zoom embed mode, or
 * a closed room. A run is one room opening; a producer's Start or Stop starts
 * a new one (stream-timeline.ts RUN_BOUNDARY_KINDS).
 *
 * Not recognised: a host stopping the live stream from inside Zoom's own
 * client. That reads as a drop and is restarted; producers stop the stream
 * from the console (docs/WEBINAR_STREAMING.html).
 */
import { db, dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { controlWebinarLiveStream } from "@/lib/webinar/livestream";
import { probeStream } from "@/lib/webinar/stream-probe";
import { lastStreamObservation, recordStreamEvent, runBoundarySince } from "@/lib/webinar/stream-timeline";

/**
 * A second look this long after the first miss, so a quick RTMP reconnect is not a drop. Kept under the
 * worker's 25 s shutdown drain, so a deploy mid-wait still releases the job lease (review of 439b4d8e).
 */
export const CONFIRM_DELAY_MS = 20_000;
export const MAX_AUTO_RESTARTS = 5;
const RESTART_BACKOFF_BASE_MS = 60_000;
export const MAX_ROOMS_PER_TICK = 20;

interface StreamState {
  /** Last state written to the timeline in this run: up, down, or unknown (not seen live yet). */
  up: boolean | null;
  restarts: number;
  nextRestartAt: number;
}

/** Per room run (stream key + the room's opening time), in the worker process. */
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
  roomOpenedAt: string | null;
  /** The in-memory state key: a reopened room is a new run, never the old one's "up". */
  runKey: string;
}

export interface WatchdogReport {
  checked: number;
  dropped: number;
  restartsRequested: number;
}

/** The anchor-in-Custom-stream, not-stopped test, shared by the scan and the re-check before acting. */
function watchedWebinar(sessionId: string, settings: unknown) {
  const webinar = readWebinarSettings(settings);
  if (webinar?.sessionId !== sessionId || webinar.viewingMode !== "hls" || webinar.streamStoppedAt) return null;
  return webinar;
}

async function findOpenStreamRooms(): Promise<WatchedRoom[]> {
  // Privileged lane: a cross-tenant scan for open rooms; each room's work then runs in its own tenant.
  const rows = await dbOperator.eventSession.findMany({
    where: {
      status: "LIVE",
      event: { eventType: "WEBINAR" },
      zoomMeeting: { is: { liveStreamEnabled: true, streamKey: { not: null } } },
    },
    // Newest first, so a long-forgotten open room never pushes today's webinar past the cap.
    orderBy: { startTime: "desc" },
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
    const webinar = watchedWebinar(row.id, row.event.settings);
    if (!webinar || !row.zoomMeeting?.streamKey) continue;
    const roomOpenedAt = webinar.roomOpenedAt ?? null;
    rooms.push({
      sessionId: row.id,
      sessionName: row.name,
      eventId: row.eventId,
      eventSlug: row.event.slug,
      organizationId: row.event.organizationId,
      streamKey: row.zoomMeeting.streamKey,
      roomOpenedAt,
      runKey: `${row.zoomMeeting.streamKey}:${roomOpenedAt ?? ""}`,
    });
  }
  return rooms;
}

async function stateFor(room: WatchedRoom): Promise<StreamState> {
  const known = states.get(room.runKey);
  if (known) return known;
  const opened = room.roomOpenedAt ? new Date(room.roomOpenedAt) : null;
  const last = await lastStreamObservation(
    room.eventId,
    room.sessionId,
    opened && !Number.isNaN(opened.getTime()) ? opened : null,
  );
  const state: StreamState = {
    up: last.state === null ? null : last.state === "up",
    // A worker restart mid-outage keeps the attempts already spent on this drop.
    restarts: last.restarts,
    nextRestartAt: 0,
  };
  states.set(room.runKey, state);
  return state;
}

/** Whether a missing stream is worth a second look and, if confirmed, an action. */
function needsConfirmation(state: StreamState, now: number): boolean {
  if (state.up === true) return true; // a fresh drop to record
  if (state.up === false) return state.restarts < MAX_AUTO_RESTARTS && now >= state.nextRestartAt;
  return false; // never live in this run
}

/**
 * The room as it is now, not as the scan saw it before the confirm wait (review of 439b4d8e, HIGH): a
 * producer may have pressed Stop, closed or reopened the room, or changed the stream meanwhile.
 */
async function roomStillWatched(room: WatchedRoom, tickStartedAt: Date): Promise<boolean> {
  const [session, event, meeting, boundary] = await Promise.all([
    db.eventSession.findFirst({ where: { id: room.sessionId, eventId: room.eventId }, select: { status: true } }),
    db.event.findFirst({ where: { id: room.eventId }, select: { settings: true } }),
    db.zoomMeeting.findFirst({ where: { sessionId: room.sessionId, eventId: room.eventId }, select: { streamKey: true } }),
    runBoundarySince(room.eventId, room.sessionId, tickStartedAt),
  ]);
  const webinar = event ? watchedWebinar(room.sessionId, event.settings) : null;
  return (
    session?.status === "LIVE" &&
    webinar !== null &&
    (webinar.roomOpenedAt ?? null) === room.roomOpenedAt &&
    meeting?.streamKey === room.streamKey &&
    !boundary
  );
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

async function requestRestart(room: WatchedRoom, state: StreamState, now: number, report: WatchdogReport): Promise<void> {
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
    expectNotLive: true,
  });
  const base = { eventId: room.eventId, sessionId: room.sessionId, attempt: state.restarts };
  let detail: string;
  if (result.ok) {
    apiLogger.info(base, "webinar-stream:auto-restart-requested");
    detail = `Attempt ${state.restarts} of ${MAX_AUTO_RESTARTS}`;
  } else if (result.code === "NOT_LIVE_IN_ZOOM") {
    // The host ended the webinar in Zoom: nothing to restart, so no more attempts on this drop.
    state.restarts = MAX_AUTO_RESTARTS;
    apiLogger.warn(base, "webinar-stream:auto-restart-stopped-not-live-in-zoom");
    detail = "The webinar is not running in Zoom, so no more automatic restarts";
  } else {
    apiLogger.warn({ ...base, code: result.code }, "webinar-stream:auto-restart-failed");
    detail = result.message;
  }
  await recordStreamEvent({
    organizationId: room.organizationId,
    eventId: room.eventId,
    sessionId: room.sessionId,
    kind: result.ok ? "AUTO_RESTART_REQUESTED" : "AUTO_RESTART_FAILED",
    detail,
    source: "worker",
  });
  if (!result.ok && result.code !== "NOT_LIVE_IN_ZOOM" && state.restarts >= MAX_AUTO_RESTARTS) {
    apiLogger.warn({ eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:auto-restart-gave-up");
  }
}

async function onConfirmedMissing(
  room: WatchedRoom,
  state: StreamState,
  now: number,
  tickStartedAt: Date,
  report: WatchdogReport,
): Promise<void> {
  if (!(await roomStillWatched(room, tickStartedAt))) {
    apiLogger.info({ eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:skipped-room-changed");
    return;
  }
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
  await requestRestart(room, state, now, report);
}

/** Run `fn` for a room inside its own tenant; one room's failure never stops the others. */
async function forRoom(room: WatchedRoom, fn: () => Promise<void>): Promise<void> {
  try {
    await runWithTenant(room.organizationId, fn);
  } catch (err) {
    apiLogger.error({ err, eventId: room.eventId, sessionId: room.sessionId }, "webinar-stream:watchdog-room-failed");
  }
}

export async function runStreamWatchdogTick(
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WatchdogReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report: WatchdogReport = { checked: 0, dropped: 0, restartsRequested: 0 };
  const tickStartedAt = new Date(now());

  const rooms = await findOpenStreamRooms();
  // Forget runs whose room is no longer open, stopped by the producer, or reopened (a new run key).
  const live = new Set(rooms.map((r) => r.runKey));
  for (const key of states.keys()) if (!live.has(key)) states.delete(key);
  if (rooms.length === 0) return report;

  const firstLook = await Promise.all(rooms.map((r) => probeStream(r.streamKey)));
  const toConfirm: { room: WatchedRoom; state: StreamState }[] = [];
  for (const [i, room] of rooms.entries()) {
    report.checked += 1;
    await forRoom(room, async () => {
      const state = await stateFor(room);
      if (firstLook[i] === "live") await onArriving(room, state);
      else if (firstLook[i] === "absent" && needsConfirmation(state, now())) toConfirm.push({ room, state });
      // "unknown" (MediaMTX slow or unreachable): no evidence, nothing done.
    });
  }
  // The wait happens only when a room needs it: a room never live yet no longer costs every tick 20 s.
  if (toConfirm.length === 0) return report;
  await sleep(CONFIRM_DELAY_MS);

  const secondLook = await Promise.all(toConfirm.map(({ room }) => probeStream(room.streamKey)));
  for (const [i, { room, state }] of toConfirm.entries()) {
    await forRoom(room, async () => {
      if (secondLook[i] === "live") await onArriving(room, state);
      else if (secondLook[i] === "absent") await onConfirmedMissing(room, state, now(), tickStartedAt, report);
    });
  }
  return report;
}
