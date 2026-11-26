/**
 * Recording a partner's stream: start, stop, finish, and the sweep that keeps
 * the stream server in step (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md,
 * step 1). The rules are in src/lib/webinar/stream-recording.ts; this file is
 * the reads, the writes and the calls to the stream server.
 *
 * THE DATABASE IS THE INTENT, THE STREAM SERVER FOLLOWS. Each action writes the
 * recording's state first and then tells MediaMTX (mediamtx-control.ts). When
 * that call fails the action still succeeded: the answer carries `server` with
 * `ok: false` INSIDE an `ok: true` result, the route tells the producer, and
 * the minute sweep (src/lib/webinar/stream-recording-sweep.ts, from the stream
 * watchdog job) makes the server agree through keepRecordingInStep below. The
 * same sweep covers a stream server that restarted and forgot its settings,
 * and closes a recording nobody finished.
 *
 * NEVER TELL THE SERVER FROM A ROW READ EARLIER (review of 7563027f7). The
 * first version of the sweep listed the recordings and then told the server
 * what each had said when listed; a Stop pressed in between was undone, and
 * the stream was recorded for a minute while the row said paused. Every path
 * now goes through tellSettled, which reads the row, tells the server, reads
 * again, and tells once more if the row moved meanwhile.
 *
 * Only a partner's stream is recorded this way. Our own Zoom webinars have
 * Zoom's cloud recording, which does not depend on the stream reaching us.
 *
 * The stream key is asked of session-stream.ts at the moment of each call and
 * handed straight to the control module. It is never stored on the recording,
 * returned, or logged.
 *
 * Errors are values for every expected refusal; a database error throws, to
 * the route's own catch. Never imports next/server. The caller has already
 * authorised the event (webinar.manage).
 *
 * Each start, stop and finish is also a line on the console's stream timeline
 * (stream-timeline.ts), beside the audit row.
 *
 * The MP4 is made by stream-recording-archive.ts (the worker); download and
 * delete are here (step 4), and the retention job deletes through the same
 * deleteStreamRecording. The feature stays dark (STREAM_RECORDING_ENABLED)
 * until the owner's steps in the plan's §8 are done.
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isStreamRecordingEnabled } from "@/lib/module-flags";
import {
  clearPathRecording,
  CONTROL_FAILURE_MESSAGE,
  isMediamtxControlConfigured,
  setPathRecording,
  type ControlFailure,
  type RecordingChangeResult,
} from "@/lib/webinar/mediamtx-control";
import { freeDiskBytes, RECORDING_MIN_FREE_BYTES } from "@/lib/webinar/recording-disk";
import { sessionStream } from "@/lib/webinar/session-stream";
import { deleteStoredFiles, listStoredFiles, signStoredFileDownload } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { recordStreamEvent, type StreamEventKind } from "@/lib/webinar/stream-timeline";
import { updateEventSettings } from "@/lib/event-settings";
import { readWebinarSettings } from "@/lib/webinar";
import {
  finishesAfterRoomClosed,
  isRecordingOpen,
  pausesAfterStart,
  pausesAfterStop,
  recordingDeleteAfter,
  recordingOverran,
  readRecordWithRoom,
  recordingStoragePrefix,
  recordingTransition,
  roomOpenedTooEarlyToRecord,
  type RecordWithRoom,
  serverSetting,
  type RecordingAction,
  type RecordingStatus,
} from "@/lib/webinar/stream-recording";

/** Whether recording can be offered on this server: the owner's switch, and a stream server we can talk to. */
export function streamRecordingAvailable(): boolean {
  return isStreamRecordingEnabled() && isMediamtxControlConfigured();
}

/** Staff in the dashboard, or the system itself (the sweep, the room closing). Never the agent or an API key. */
export type StreamRecordingSource = "rest" | "worker" | "room";

interface At {
  eventId: string;
  sessionId: string;
}

interface Caller extends At {
  /** For the audit row. Null only where the system acts on a recording whose organisation it was not handed. */
  organizationId: string | null;
  /** Null when the system acts. */
  userId: string | null;
  source: StreamRecordingSource;
}

/**
 * Whoever STARTS a recording names its organisation: the row's tenant column
 * is stamped from it, and a row without one is invisible once row policies
 * apply (review of 7563027f7).
 */
type StartCaller = Caller & { organizationId: string };

export type StreamRecordingErrorCode =
  | "NOT_AVAILABLE"
  | "DISK_LOW"
  | "NOT_PARTNER_STREAM"
  | "AGREEMENT_REQUIRED"
  | "NOT_STARTED"
  | "ALREADY_FINISHED"
  | "STILL_RECORDING"
  | "STILL_PREPARING"
  | "NO_FILE";

/** What staff see of a recording. Never the stream key, never where the files are. */
export interface StreamRecordingView {
  id: string;
  sessionId: string;
  status: RecordingStatus;
  partnerAgreedAt: Date;
  startedAt: Date;
  lastStartedAt: Date;
  stoppedAt: Date | null;
  finishedAt: Date | null;
  segmentCount: number;
  totalBytes: number;
  durationMs: number;
  /** When the newest piece in storage ends: how the console tells pieces are still arriving. Null before the first. */
  lastPieceAt: Date | null;
  hasArchive: boolean;
  archiveBytes: number | null;
  error: string | null;
  deleteAfter: Date | null;
}

/** Whether the stream server took the change. `ok: false` is for the producer to see, and the sweep to retry. */
export type ServerOutcome = { ok: true; changed: boolean } | { ok: false; code: ControlFailure; message: string };

export type StreamRecordingResult =
  | { ok: true; recording: StreamRecordingView; server?: ServerOutcome }
  | { ok: false; code: StreamRecordingErrorCode; message: string };

const MESSAGES: Record<StreamRecordingErrorCode, string> = {
  NOT_AVAILABLE: "Recording is not set up on this server.",
  DISK_LOW:
    "Recording was not started: the server is short of disk space, or it could not be checked. A recording needs room for up to two hours of video on the server before it reaches storage.",
  NOT_PARTNER_STREAM: "Only a partner's stream is recorded here. This session has none.",
  AGREEMENT_REQUIRED: "Confirm that the partner has agreed to be recorded before starting.",
  NOT_STARTED: "This webinar has no recording.",
  ALREADY_FINISHED: "This webinar's recording is already finished. Delete it to record again.",
  STILL_RECORDING: "Finish the recording before deleting it.",
  STILL_PREPARING: "The recording's file is still being made. Try again in a few minutes.",
  NO_FILE: "This recording has no file to download.",
};

const ROW_SELECT = {
  id: true,
  sessionId: true,
  eventId: true,
  organizationId: true,
  status: true,
  partnerAgreedAt: true,
  startedAt: true,
  lastStartedAt: true,
  stoppedAt: true,
  pauses: true,
  finishedAt: true,
  serverClearedAt: true,
  storagePrefix: true,
  segmentCount: true,
  totalBytes: true,
  durationMs: true,
  archivePath: true,
  archiveBytes: true,
  error: true,
  deleteAfter: true,
  session: { select: { endTime: true, status: true } },
  // The newest piece only, for lastPieceAt. One row by the (recordingId, seq) unique.
  segments: { orderBy: { seq: "desc" }, take: 1, select: { startedAt: true, durationMs: true } },
} as const;

interface Row {
  id: string;
  sessionId: string;
  eventId: string;
  organizationId: string | null;
  status: RecordingStatus;
  partnerAgreedAt: Date;
  startedAt: Date;
  lastStartedAt: Date;
  stoppedAt: Date | null;
  pauses: unknown;
  finishedAt: Date | null;
  serverClearedAt: Date | null;
  storagePrefix: string;
  segmentCount: number;
  totalBytes: bigint;
  durationMs: number;
  archivePath: string | null;
  archiveBytes: bigint | null;
  error: string | null;
  deleteAfter: Date | null;
  session: { endTime: Date; status: string };
  segments: { startedAt: Date; durationMs: number }[];
}

function toView(row: Row): StreamRecordingView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    partnerAgreedAt: row.partnerAgreedAt,
    startedAt: row.startedAt,
    lastStartedAt: row.lastStartedAt,
    stoppedAt: row.stoppedAt,
    finishedAt: row.finishedAt,
    segmentCount: row.segmentCount,
    // Bytes of video fit a JavaScript number with room to spare (9 PB); a bigint cannot be sent as JSON.
    totalBytes: Number(row.totalBytes),
    durationMs: row.durationMs,
    lastPieceAt: lastPieceEnd(row.segments[0]),
    hasArchive: row.archivePath !== null,
    archiveBytes: row.archiveBytes === null ? null : Number(row.archiveBytes),
    error: row.error,
    deleteAfter: row.deleteAfter,
  };
}

function lastPieceEnd(piece: { startedAt: Date; durationMs: number } | undefined): Date | null {
  return piece ? new Date(piece.startedAt.getTime() + piece.durationMs) : null;
}

function refuse(caller: Caller, op: RecordingAction | "download" | "delete", code: StreamRecordingErrorCode): { ok: false; code: StreamRecordingErrorCode; message: string } {
  // A person refused is a warning. The system finding nothing to do (the room closing on a webinar
  // that was never recorded, which is most of them, or one already finished) is not.
  const level = caller.source !== "rest" && (code === "NOT_STARTED" || code === "ALREADY_FINISHED") ? "info" : "warn";
  apiLogger[level]({ eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, code }, `stream-recording:${op}-refused`);
  return { ok: false, code, message: MESSAGES[code] };
}

const TIMELINE_KIND: Record<string, StreamEventKind> = {
  STREAM_RECORDING_STARTED: "RECORDING_STARTED",
  STREAM_RECORDING_RESUMED: "RECORDING_STARTED",
  STREAM_RECORDING_STOPPED: "RECORDING_STOPPED",
  STREAM_RECORDING_FINISHED: "RECORDING_FINISHED",
};

const REASON_TEXT: Record<string, string> = {
  "room-closed": "The room was closed",
  "room-closed-stop": "The room was closed: finished in 10 minutes unless the room is opened again",
  "rehearsal-closed-stop": "The room was closed before the start: a rehearsal",
  "room-opened": "The room was opened",
  overran: "Still open 6 hours after the scheduled end",
};

function timelineDetail(action: string, byRoom: boolean, reason: string | undefined): string | null {
  if (action !== "STREAM_RECORDING_RESUMED") return reason ?? null;
  return byRoom ? "Carried on: the room was opened" : "Carried on after a stop";
}

/**
 * Who started, stopped or finished a recording, as an audit row and a line on
 * the stream timeline. Never the stream key or where the files are. A
 * timeline line needs the organisation; the system acting on a recording it
 * was not handed one for writes the audit row only.
 */
async function audit(caller: Caller, action: string, entityId: string, changes: Record<string, unknown>): Promise<void> {
  const kind = TIMELINE_KIND[action];
  if (kind && caller.organizationId) {
    const reasonKey = action === "STREAM_RECORDING_STOPPED" ? `${String(changes.reason)}-stop` : String(changes.reason);
    const reason = REASON_TEXT[reasonKey];
    await recordStreamEvent({
      organizationId: caller.organizationId,
      eventId: caller.eventId,
      sessionId: caller.sessionId,
      kind,
      userId: caller.userId,
      detail: timelineDetail(action, changes.reason === "room-opened", reason),
      source: caller.source === "worker" ? "worker" : "rest",
    });
  }
  try {
    await db.auditLog.create({
      data: {
        ...(caller.organizationId ? { organizationId: caller.organizationId } : {}),
        eventId: caller.eventId,
        ...(caller.userId ? { userId: caller.userId } : {}),
        action,
        entityType: "StreamRecording",
        entityId,
        changes: { ...changes, sessionId: caller.sessionId, source: caller.source },
      },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: caller.eventId, action }, "stream-recording:audit-failed");
  }
}

function readRow(at: At): Promise<Row | null> {
  return db.streamRecording.findFirst({ where: { sessionId: at.sessionId, eventId: at.eventId }, select: ROW_SELECT });
}

/** The session's recording as staff see it, or null when it has none. */
export async function getStreamRecording(at: At): Promise<StreamRecordingView | null> {
  const row = await readRow(at);
  return row ? toView(row) : null;
}

/** Room on the server's disk for the stream server's buffer (recording-disk.ts). */
async function diskHasRoom(at: At): Promise<boolean> {
  const free = await freeDiskBytes();
  if (free !== null && free >= RECORDING_MIN_FREE_BYTES) return true;
  apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, freeBytes: free }, "stream-recording:disk-low");
  return false;
}

/** The session's partner stream key, or null when its stream is not a partner's. Handed on, never kept. */
async function partnerKey(at: At): Promise<string | null> {
  const stream = await sessionStream(at.sessionId, at.eventId);
  return stream && stream.source === "external" ? stream.streamKey : null;
}

/** Make the stream server hold what this state calls for. Never throws; a failure is logged and returned. */
async function tellServer(at: At, streamKey: string, status: RecordingStatus): Promise<RecordingChangeResult> {
  const setting = serverSetting(status);
  const result = setting === "none" ? await clearPathRecording(streamKey) : await setPathRecording(streamKey, setting === "record");
  if (!result.ok) apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, code: result.code, setting }, "stream-recording:server-not-told");
  return result;
}

function toOutcome(result: RecordingChangeResult): ServerOutcome {
  return result.ok ? result : { ok: false, code: result.code, message: CONTROL_FAILURE_MESSAGE[result.code] };
}

const NO_STREAM: ServerOutcome = {
  ok: false,
  code: "NOT_CONFIGURED",
  message: "This session no longer has a partner stream, so the stream server could not be told.",
};

/** Open recordings without a partner stream already reported, so each is said once, not every minute. */
const reportedWithoutStream = new Set<string>();
const REPORTED_MAX = 500;

/** Test hook. */
export function resetStreamRecordingReports(): void {
  reportedWithoutStream.clear();
}

/** The stream server is confirmed to hold nothing for this closed recording: the sweep stops asking. */
async function markServerCleared(row: Row): Promise<void> {
  if (row.serverClearedAt || isRecordingOpen(row.status)) return;
  await db.streamRecording.updateMany({ where: { id: row.id, serverClearedAt: null }, data: { serverClearedAt: new Date() } });
}

/**
 * A recording whose session has no partner stream to tell. A closed one is
 * marked as cleared, since there is no key left to clear with and asking every
 * minute would never end; an open one is said once.
 */
async function withoutStream(at: At, row: Row): Promise<void> {
  if (!isRecordingOpen(row.status)) {
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, status: row.status }, "stream-recording:closed-without-partner-stream");
    await markServerCleared(row);
    return;
  }
  if (reportedWithoutStream.has(row.id)) return;
  if (reportedWithoutStream.size >= REPORTED_MAX) reportedWithoutStream.clear();
  reportedWithoutStream.add(row.id);
  apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, status: row.status }, "stream-recording:recording-without-partner-stream");
}

/**
 * Tell the stream server what the recording says NOW, and make sure that is
 * still what it says once the server has been told: the row is read, the
 * server told, the row read again, and if it moved meanwhile the server is told
 * once more. A row that is gone leaves no setting behind.
 *
 * `row` null: the session has no recording (any more).
 */
async function tellSettled(at: At): Promise<{ row: Row | null; server: ServerOutcome }> {
  let row = await readRow(at);
  let server: ServerOutcome = NO_STREAM;
  for (let round = 0; round < 2; round++) {
    const streamKey = await partnerKey(at);
    if (!row) {
      if (streamKey) server = toOutcome(await clearPathRecording(streamKey));
      return { row: null, server };
    }
    if (!streamKey) {
      await withoutStream(at, row);
      return { row, server: NO_STREAM };
    }
    const told = await tellServer(at, streamKey, row.status);
    server = toOutcome(told);
    if (told.ok && serverSetting(row.status) === "none") await markServerCleared(row);
    const after = await readRow(at);
    if (after && after.status === row.status) return { row: after, server };
    row = after;
  }
  return { row, server };
}

/**
 * Move an existing recording, if it is still in the state we read. False when
 * someone else moved it meanwhile: the caller reads again and answers with
 * what is there, so two people pressing at once never overwrite each other.
 */
async function move(
  row: Row,
  data: {
    status: RecordingStatus;
    lastStartedAt?: Date;
    stoppedAt?: Date;
    finishedAt?: Date;
    pauses?: { from: string; to: string | null }[];
  },
): Promise<boolean> {
  const { count } = await db.streamRecording.updateMany({ where: { id: row.id, status: row.status }, data });
  return count === 1;
}

/** The answer after a write: the row as it now is, and what the stream server said. */
async function answer(caller: Caller, op: RecordingAction): Promise<StreamRecordingResult> {
  const { row, server } = await tellSettled(caller);
  // Deleted while we were at it: there is no recording to answer with.
  if (!row) return refuse(caller, op, "NOT_STARTED");
  return { ok: true, recording: toView(row), server };
}

async function createRecording(input: StartCaller & { agreement?: RecordWithRoom }, now: Date): Promise<Row | null> {
  const id = randomUUID();
  try {
    return await db.streamRecording.create({
      data: {
        id,
        sessionId: input.sessionId,
        eventId: input.eventId,
        organizationId: input.organizationId,
        status: "RECORDING",
        // Started by the room opening: the agreement is the one confirmed when "record with the room" was switched on.
        partnerAgreedAt: input.agreement?.agreedAt ?? now,
        partnerAgreedByUserId: input.agreement ? input.agreement.agreedByUserId : input.userId,
        startedAt: now,
        startedByUserId: input.userId,
        lastStartedAt: now,
        storagePrefix: recordingStoragePrefix({ eventId: input.eventId, sessionId: input.sessionId, recordingId: id }),
        deleteAfter: recordingDeleteAfter(now),
      },
      select: ROW_SELECT,
    });
  } catch (err) {
    // Two people starting at once: the session's one recording already exists.
    if ((err as { code?: string }).code !== "P2002") throw err;
    return null;
  }
}

/**
 * Start recording, or carry on a paused one. The first start needs the
 * partner's agreement, which is stored with who gave it and when. Before the
 * stream begins this arms the recording: the stream server records from the
 * moment the partner connects.
 */
export async function startStreamRecording(
  input: StartCaller & { partnerAgreed?: boolean; now?: Date; agreement?: RecordWithRoom; reason?: "room-opened" },
): Promise<StreamRecordingResult> {
  if (!streamRecordingAvailable()) return refuse(input, "start", "NOT_AVAILABLE");
  if (!(await partnerKey(input))) return refuse(input, "start", "NOT_PARTNER_STREAM");
  const now = input.now ?? new Date();

  const existing = await readRow(input);
  const step = recordingTransition(existing?.status ?? null, "start");
  if (!step.ok) return refuse(input, "start", step.code);
  // Pessimistic: free space that could not be read is not taken as enough. Asked only when this
  // Start would switch recording on, so pressing Start on a running recording never fails on it.
  if (step.changed && !(await diskHasRoom(input))) return refuse(input, "start", "DISK_LOW");

  if (!existing) {
    if (input.partnerAgreed !== true) return refuse(input, "start", "AGREEMENT_REQUIRED");
    const created = await createRecording(input, now);
    // Null: lost the race to another Start. Theirs is the same recording, and the answer reads it.
    if (created) {
      apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason }, "stream-recording:started");
      await audit(input, "STREAM_RECORDING_STARTED", created.id, { partnerAgreed: true, ...(input.reason ? { reason: input.reason } : {}) });
    }
    return answer(input, "start");
  }

  if (!step.changed) return answer(input, "start");
  // The list is written from the row read above; the status in the same where clause means nobody changed it meanwhile.
  if (await move(existing, { status: "RECORDING", lastStartedAt: now, pauses: pausesAfterStart(existing.pauses, now) })) {
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason }, "stream-recording:resumed");
    await audit(input, "STREAM_RECORDING_RESUMED", existing.id, input.reason ? { reason: input.reason } : {});
    return answer(input, "start");
  }
  // Someone moved it first. If they closed it, this Start did not happen and says so, instead of
  // answering "ok" with a finished recording.
  const current = await readRow(input);
  const again = recordingTransition(current?.status ?? null, "start");
  if (!current || !again.ok) return refuse(input, "start", again.ok ? "NOT_STARTED" : again.code);
  return answer(input, "start");
}

/**
 * Stop recording for now. Start again continues the same recording, with a
 * break marked. `reason` "room-closed" when the room closing stopped it.
 */
export async function stopStreamRecording(
  input: Caller & { now?: Date; reason?: "room-closed" | "rehearsal-closed" },
): Promise<StreamRecordingResult> {
  const existing = await readRow(input);
  const step = recordingTransition(existing?.status ?? null, "stop");
  if (!step.ok || !existing) return refuse(input, "stop", step.ok ? "NOT_STARTED" : step.code);

  const now = input.now ?? new Date();
  if (step.changed && (await move(existing, { status: "PAUSED", stoppedAt: now, pauses: pausesAfterStop(existing.pauses, now) }))) {
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason }, "stream-recording:stopped");
    await audit(input, "STREAM_RECORDING_STOPPED", existing.id, input.reason ? { reason: input.reason } : {});
  }
  // Lost a race here means someone else stopped or closed it: either way it is not recording, which is what Stop asked.
  return answer(input, "stop");
}

/**
 * Close the recording for good: by staff, by the room closing, or by the sweep
 * when it has run past its limit. Works with the owner's switch off, so a
 * recording can always be closed. Closing twice is not an error.
 */
export async function finishStreamRecording(
  input: Caller & { reason: "staff" | "room-closed" | "overran"; now?: Date },
): Promise<StreamRecordingResult> {
  const existing = await readRow(input);
  const step = recordingTransition(existing?.status ?? null, "finish");
  if (!step.ok || !existing) return refuse(input, "finish", step.ok ? "NOT_STARTED" : step.code);

  const now = input.now ?? new Date();
  // When recording last stopped: the moment it was paused, or now. A Stop from before a later Start is not it.
  const stoppedAt = existing.status === "PAUSED" ? (existing.stoppedAt ?? now) : now;
  if (step.changed && (await move(existing, { status: "FINISHING", stoppedAt, finishedAt: now }))) {
    apiLogger.info(
      { eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason },
      "stream-recording:finishing",
    );
    await audit(input, "STREAM_RECORDING_FINISHED", existing.id, { reason: input.reason });
  }
  return answer(input, "finish");
}

/**
 * The room closing ends the webinar, so it STOPS the recording (plan §4.3);
 * the sweep finishes it ROOM_CLOSED_FINISH_GRACE_MS later unless the room was
 * opened again (review of be8511218, HIGH: finishing at once left a mistaken
 * close no way back). Called by the producer's close and by the automatic
 * close, only when the webinar is over (a close before the start is a
 * rehearsal, and leaves the recording as it is). Never throws: the room is
 * already closed, and a recording left running is finished by the sweep at
 * its limit.
 */
export async function stopRecordingOnRoomClose(
  at: At & { organizationId: string; userId: string | null; source: "room" | "worker" },
): Promise<void> {
  try {
    await stopStreamRecording({ ...at, reason: "room-closed" });
  } catch (err) {
    apiLogger.error({ err, eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:stop-on-room-close-failed");
  }
}

// ── Recording with the room (Nov 26, 2026) ─────────────────────────────────

export type RecordWithRoomResult =
  | { ok: true; recordWithRoom: { agreedAt: Date } | null; recording: RoomOpenRecording }
  | { ok: false; code: StreamRecordingErrorCode; message: string };

/** The webinar's "record with the room" choice as staff see it: when the agreement was confirmed, or null when off. */
export function recordWithRoomView(settings: unknown): { agreedAt: Date } | null {
  const choice = readRecordWithRoom(settings);
  return choice ? { agreedAt: choice.agreedAt } : null;
}

/**
 * Switch "record with the room" on or off. On needs the partner's agreement,
 * stored with who confirmed it and when; it becomes the recording's agreement
 * when the room starts it. Off is always allowed, with the owner's switch off
 * too. Changes nothing about a recording already made: Stop and Finish stay
 * as they are.
 *
 * Switched on while the room is ALREADY open (review of 392f9a92f, MED): the
 * room opening has passed, so the recording is started now, as the opening
 * would have, when the webinar has none yet. One that staff stopped is left
 * stopped ("Start again" is theirs to press).
 */
export async function setRecordWithRoom(
  input: StartCaller & { on: boolean; partnerAgreed?: boolean; now?: Date },
): Promise<RecordWithRoomResult> {
  const op = "record-with-room" as const;
  if (input.on) {
    if (!streamRecordingAvailable()) return refuseSetting(input, op, "NOT_AVAILABLE");
    if (!(await partnerKey(input))) return refuseSetting(input, op, "NOT_PARTNER_STREAM");
    if (input.partnerAgreed !== true) return refuseSetting(input, op, "AGREEMENT_REQUIRED");
  }
  const agreedAt = input.now ?? new Date();
  const stored = input.on ? { agreedAt: agreedAt.toISOString(), agreedByUserId: input.userId } : null;
  await updateEventSettings(
    input.eventId,
    (current) => {
      const webinar = current.webinar && typeof current.webinar === "object" ? { ...(current.webinar as Record<string, unknown>) } : {};
      if (stored) webinar.recordWithRoom = stored;
      else delete webinar.recordWithRoom;
      return { ...current, webinar };
    },
    { organizationId: input.organizationId },
  );
  apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, on: input.on }, "stream-recording:record-with-room-set");
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId,
        eventId: input.eventId,
        ...(input.userId ? { userId: input.userId } : {}),
        action: input.on ? "STREAM_RECORDING_WITH_ROOM_ON" : "STREAM_RECORDING_WITH_ROOM_OFF",
        entityType: "Event",
        entityId: input.eventId,
        changes: { sessionId: input.sessionId, source: input.source, ...(input.on ? { partnerAgreed: true } : {}) },
      },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: input.eventId }, "stream-recording:audit-failed");
  }
  const recording = stored ? await startIfRoomAlreadyOpen(input, agreedAt) : "off";
  return { ok: true, recordWithRoom: stored ? { agreedAt } : null, recording };
}

async function startIfRoomAlreadyOpen(input: StartCaller, now: Date): Promise<RoomOpenRecording> {
  const [session, existing, event] = await Promise.all([
    db.eventSession.findFirst({ where: { id: input.sessionId, eventId: input.eventId }, select: { status: true } }),
    readRow(input),
    db.event.findFirst({ where: { id: input.eventId, organizationId: input.organizationId }, select: { settings: true } }),
  ]);
  if (session?.status !== "LIVE" || existing || !event) return "off";
  return startRecordingOnRoomOpen({ ...input, settings: event.settings, now });
}

function refuseSetting(caller: Caller, op: "record-with-room", code: StreamRecordingErrorCode): { ok: false; code: StreamRecordingErrorCode; message: string } {
  apiLogger.warn({ eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, code }, `stream-recording:${op}-refused`);
  return { ok: false, code, message: code === "AGREEMENT_REQUIRED" ? "Confirm that the partner has agreed to be recorded first." : MESSAGES[code] };
}

/**
 * What opening the room did to the recording, for the producer's message. "server-not-told": the
 * recording is on in our records but the stream server did not take it yet (the sweep retries);
 * "finished": the webinar's recording is already finished, so nothing more can be recorded.
 */
export type RoomOpenRecording = "off" | "started" | "server-not-told" | "too-early" | "finished" | "not-started";

/**
 * The room was opened: with "record with the room" on, start the recording,
 * or carry on a stopped one. Not when the room opens more than 30 minutes
 * before the scheduled start (a rehearsal). Never throws: the room is already
 * open, and a recording that did not start is said in the answer and the log.
 */
export async function startRecordingOnRoomOpen(
  at: At & { organizationId: string; userId: string | null; settings: unknown; now?: Date },
): Promise<RoomOpenRecording> {
  const choice = readRecordWithRoom(at.settings);
  if (!choice) return "off";
  const now = at.now ?? new Date();
  try {
    const session = await db.eventSession.findFirst({ where: { id: at.sessionId, eventId: at.eventId }, select: { startTime: true } });
    if (session && roomOpenedTooEarlyToRecord(session.startTime, now)) {
      apiLogger.info({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:room-opened-too-early-to-record");
      return "too-early";
    }
    const result = await startStreamRecording({
      organizationId: at.organizationId,
      eventId: at.eventId,
      sessionId: at.sessionId,
      userId: at.userId,
      source: "room",
      partnerAgreed: true,
      agreement: choice,
      reason: "room-opened",
      now,
    });
    // A refusal (disk low, recording already finished, switch off) is logged by the start.
    if (!result.ok) return result.code === "ALREADY_FINISHED" ? "finished" : "not-started";
    return result.server && !result.server.ok ? "server-not-told" : "started";
  } catch (err) {
    apiLogger.error({ err, eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:start-on-room-open-failed");
    return "not-started";
  }
}

/**
 * A room opened too early to be recorded (more than 30 minutes before the
 * start) and left open into the webinar: the minute sweep starts its
 * recording once the 30 minutes before the start are reached
 * (stream-recording-sweep.ts finds the rooms). Read again here, inside the
 * room's tenant, so a list a minute old never acts: only while the room is
 * still open, the choice still on, the room still not opened again inside the
 * window, and the webinar has NO recording yet. A recording staff stopped is
 * theirs to carry on, never the sweep's.
 */
export async function startRecordingForEarlyRoom(at: At & { organizationId: string }, now: Date): Promise<boolean> {
  const [event, session, existing] = await Promise.all([
    db.event.findFirst({ where: { id: at.eventId, organizationId: at.organizationId }, select: { settings: true } }),
    db.eventSession.findFirst({ where: { id: at.sessionId, eventId: at.eventId }, select: { startTime: true, status: true } }),
    readRow(at),
  ]);
  if (!event || !session || existing || session.status !== "LIVE") return false;
  if (!earlyRoomDue(event.settings, session.startTime, now)) return false;
  const choice = readRecordWithRoom(event.settings);
  if (!choice) return false;
  const result = await startStreamRecording({
    organizationId: at.organizationId,
    eventId: at.eventId,
    sessionId: at.sessionId,
    userId: null,
    source: "worker",
    partnerAgreed: true,
    agreement: choice,
    reason: "room-opened",
    now,
  });
  if (result.ok) apiLogger.info({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:started-for-early-room");
  return result.ok;
}

/**
 * Whether a room left open since too early is now due its recording: opened
 * before the window, and the window reached, until 15 minutes after the start
 * (after that, no recording means someone deleted one on purpose).
 */
export function earlyRoomDue(settings: unknown, startTime: Date, now: Date): boolean {
  if (!readRecordWithRoom(settings)) return false;
  const opened = readWebinarSettings(settings)?.roomOpenedAt;
  const openedAt = opened ? new Date(opened) : null;
  if (!openedAt || Number.isNaN(openedAt.getTime())) return false;
  if (!roomOpenedTooEarlyToRecord(startTime, openedAt)) return false;
  if (roomOpenedTooEarlyToRecord(startTime, now)) return false;
  return now.getTime() <= startTime.getTime() + EARLY_ROOM_LATEST_MS;
}

/** How long after the start the sweep still starts a recording for a room opened too early. */
export const EARLY_ROOM_LATEST_MS = 15 * 60 * 1000;

/**
 * The room was closed before the scheduled start (a rehearsal): with "record
 * with the room" on, the recording is stopped, never finished, so it carries
 * on when the room is opened for the webinar. A recording staff started by
 * hand is left as it is (plan §4.3). Never throws.
 */
export async function stopRecordingOnRehearsalClose(
  at: At & { organizationId: string; userId: string | null; settings: unknown },
): Promise<void> {
  if (!readRecordWithRoom(at.settings)) return;
  try {
    // The ordinary day-before test has no recording: nothing to stop, and nothing to warn about (review of 392f9a92f).
    const existing = await readRow(at);
    if (existing?.status !== "RECORDING") return;
    await stopStreamRecording({ ...at, source: "room", reason: "rehearsal-closed" });
  } catch (err) {
    apiLogger.error({ err, eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:stop-on-rehearsal-close-failed");
  }
}

/** How long a download link works. Enough to start a download; a link copied elsewhere soon dies. */
export const DOWNLOAD_LINK_SECONDS = 5 * 60;

/** A file name a browser saves under: letters, digits and hyphens from the event's address. */
function downloadFileName(eventSlug: string | null): string {
  const base = (eventSlug ?? "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "webinar"}-recording.mp4`;
}

export type StreamRecordingDownload =
  | { ok: true; url: string | null; fileName: string }
  | { ok: false; code: StreamRecordingErrorCode; message: string };

/**
 * A 5 minute link to download the recording's MP4 (D7: webinar.manage, every
 * download audited). `url` null on the local provider, which has no bucket to
 * sign for (development only).
 */
export async function streamRecordingDownload(input: Caller & { eventSlug: string | null }): Promise<StreamRecordingDownload> {
  const row = await readRow(input);
  if (!row) return refuse(input, "download", "NOT_STARTED");
  if (row.status !== "READY" || !row.archivePath) return refuse(input, "download", "NO_FILE");
  const fileName = downloadFileName(input.eventSlug);
  const url = await signStoredFileDownload({
    storedPath: row.archivePath,
    requirePrefix: UPLOAD_PREFIX.recordings,
    expiresSeconds: DOWNLOAD_LINK_SECONDS,
    contentDisposition: `attachment; filename="${fileName}"`,
    contentType: "video/mp4",
  });
  apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:download-link");
  await audit(input, "STREAM_RECORDING_DOWNLOADED", row.id, {});
  return { ok: true, url, fileName };
}

/** `filesLeft` null when the files could not even be listed: all of them are left to the daily sweep. */
export type StreamRecordingDeletion = { ok: true; filesLeft: number | null } | { ok: false; code: StreamRecordingErrorCode; message: string };

/**
 * Delete a closed recording: its row, its pieces' rows, and every file under
 * its folder (pieces and MP4). By staff (confirmed in the console), or by the
 * retention job once it is past `deleteAfter` (D4). An open recording is
 * finished first; one whose file is being made waits.
 *
 * The row goes first, then the files: a file that cannot be deleted is left
 * to the daily sweep for files no recording claims, never a row pointing at
 * nothing. In the versioned bucket a deleted file's old version is cleared by
 * the bucket's lifecycle rule (plan §8). After it, the webinar can be recorded
 * again.
 */
export async function deleteStreamRecording(input: Caller & { reason: "staff" | "retention" }): Promise<StreamRecordingDeletion> {
  const row = await readRow(input);
  if (!row) return refuse(input, "delete", "NOT_STARTED");
  if (isRecordingOpen(row.status)) return refuse(input, "delete", "STILL_RECORDING");
  if (row.status === "FINISHING") return refuse(input, "delete", "STILL_PREPARING");

  // The stream server's setting, if the sweep has not yet confirmed it gone: the sweep cannot find it once the row is.
  if (!row.serverClearedAt) {
    const key = await partnerKey(input);
    if (key) await tellServer(input, key, row.status);
  }
  const { count } = await db.streamRecording.deleteMany({ where: { id: row.id, status: row.status } });
  // Someone else deleted it, or it changed, between the read and now.
  if (count === 0) return refuse(input, "delete", "NOT_STARTED");

  // The row is gone: whatever happens to the files now, the delete happened and is audited (review of 593a7f31a).
  let files: { storedPath: string }[] | null = null;
  try {
    files = await listStoredFiles(row.storagePrefix.replace(/^\/uploads\//, ""));
  } catch (err) {
    apiLogger.warn({ err, eventId: input.eventId, sessionId: input.sessionId }, "stream-recording:delete-files-unlisted");
  }
  const failed = files
    ? (
        await deleteStoredFiles(
          files.map((f) => f.storedPath),
          UPLOAD_PREFIX.recordings,
        )
      ).failed
    : null;
  apiLogger.info(
    { eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason, files: files?.length ?? null, failed },
    "stream-recording:deleted",
  );
  await audit(input, "STREAM_RECORDING_DELETED", row.id, { reason: input.reason, files: files?.length ?? null, filesLeft: failed });
  return { ok: true, filesLeft: failed };
}

/** What the sweep found for one recording. */
export type KeepInStepOutcome = "closed" | "corrected" | "unchanged";

/**
 * The sweep's work for one recording, run inside that recording's own tenant:
 * finish it when its room has been closed for the grace, or when it ran past
 * its limit, otherwise make the stream server hold
 * what it says. Reads the recording afresh: the sweep's own list is only the
 * list of which to look at. `serverReachable` false (the control address is
 * not set up here) still closes an overrun recording, which is a database
 * matter.
 */
export async function keepRecordingInStep(
  at: At & { organizationId: string | null },
  now: Date,
  serverReachable: boolean,
): Promise<KeepInStepOutcome> {
  const row = await readRow(at);
  if (!row) return "unchanged";
  if (finishesAfterRoomClosed({ status: row.status, stoppedAt: row.stoppedAt, sessionStatus: row.session.status }, now)) {
    const closed = await finishStreamRecording({ ...at, userId: null, source: "worker", reason: "room-closed", now });
    if (!closed.ok) return "unchanged";
    apiLogger.info({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:finished-after-room-closed");
    return "closed";
  }
  if (
    isRecordingOpen(row.status) &&
    recordingOverran({ lastStartedAt: row.lastStartedAt, sessionEndTime: row.session.endTime }, now)
  ) {
    const closed = await finishStreamRecording({ ...at, userId: null, source: "worker", reason: "overran", now });
    if (!closed.ok) return "unchanged";
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording:closed-after-limit");
    return "closed";
  }
  if (!serverReachable) return "unchanged";
  const { row: after, server } = await tellSettled(at);
  if (!after || !server.ok || !server.changed) return "unchanged";
  // A closed recording's setting being removed is the ordinary end of it. For an open one, the
  // server did not hold what the recording says: a call that failed when the button was pressed, or a restart.
  if (!isRecordingOpen(after.status)) return "unchanged";
  apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, status: after.status }, "stream-recording:server-setting-put-right");
  return "corrected";
}
