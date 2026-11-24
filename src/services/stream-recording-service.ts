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
 * NOT YET HERE (later steps of the plan): shipping the pieces to S3 (step 2),
 * the console (step 3), the MP4, download, delete and retention (step 4).
 * Until step 4 a FINISHING recording stays FINISHING, which is why the feature
 * is dark until then (STREAM_RECORDING_ENABLED).
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
import {
  isRecordingOpen,
  recordingDeleteAfter,
  recordingOverran,
  recordingStoragePrefix,
  recordingTransition,
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
  | "ALREADY_FINISHED";

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
  finishedAt: true,
  serverClearedAt: true,
  segmentCount: true,
  totalBytes: true,
  durationMs: true,
  archivePath: true,
  archiveBytes: true,
  error: true,
  deleteAfter: true,
  session: { select: { endTime: true } },
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
  finishedAt: Date | null;
  serverClearedAt: Date | null;
  segmentCount: number;
  totalBytes: bigint;
  durationMs: number;
  archivePath: string | null;
  archiveBytes: bigint | null;
  error: string | null;
  deleteAfter: Date | null;
  session: { endTime: Date };
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
    hasArchive: row.archivePath !== null,
    archiveBytes: row.archiveBytes === null ? null : Number(row.archiveBytes),
    error: row.error,
    deleteAfter: row.deleteAfter,
  };
}

function refuse(caller: Caller, op: RecordingAction, code: StreamRecordingErrorCode): { ok: false; code: StreamRecordingErrorCode; message: string } {
  // A person refused is a warning. The system finding nothing to do (the room closing on a webinar
  // that was never recorded, which is most of them) is not.
  const level = caller.source !== "rest" && code === "NOT_STARTED" ? "info" : "warn";
  apiLogger[level]({ eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, code }, `stream-recording:${op}-refused`);
  return { ok: false, code, message: MESSAGES[code] };
}

/** Who started, stopped or finished a recording. Never the stream key or where the files are. */
async function audit(caller: Caller, action: string, entityId: string, changes: Record<string, unknown>): Promise<void> {
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
async function move(row: Row, data: { status: RecordingStatus; lastStartedAt?: Date; stoppedAt?: Date; finishedAt?: Date }): Promise<boolean> {
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

async function createRecording(input: StartCaller, now: Date): Promise<Row | null> {
  const id = randomUUID();
  try {
    return await db.streamRecording.create({
      data: {
        id,
        sessionId: input.sessionId,
        eventId: input.eventId,
        organizationId: input.organizationId,
        status: "RECORDING",
        partnerAgreedAt: now,
        partnerAgreedByUserId: input.userId,
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
export async function startStreamRecording(input: StartCaller & { partnerAgreed?: boolean; now?: Date }): Promise<StreamRecordingResult> {
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
      apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:started");
      await audit(input, "STREAM_RECORDING_STARTED", created.id, { partnerAgreed: true });
    }
    return answer(input, "start");
  }

  if (!step.changed) return answer(input, "start");
  if (await move(existing, { status: "RECORDING", lastStartedAt: now })) {
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:resumed");
    await audit(input, "STREAM_RECORDING_RESUMED", existing.id, {});
    return answer(input, "start");
  }
  // Someone moved it first. If they closed it, this Start did not happen and says so, instead of
  // answering "ok" with a finished recording.
  const current = await readRow(input);
  const again = recordingTransition(current?.status ?? null, "start");
  if (!current || !again.ok) return refuse(input, "start", again.ok ? "NOT_STARTED" : again.code);
  return answer(input, "start");
}

/** Stop recording for now. Start again continues the same recording, with a break marked. */
export async function stopStreamRecording(input: Caller & { now?: Date }): Promise<StreamRecordingResult> {
  const existing = await readRow(input);
  const step = recordingTransition(existing?.status ?? null, "stop");
  if (!step.ok || !existing) return refuse(input, "stop", step.ok ? "NOT_STARTED" : step.code);

  if (step.changed && (await move(existing, { status: "PAUSED", stoppedAt: input.now ?? new Date() }))) {
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:stopped");
    await audit(input, "STREAM_RECORDING_STOPPED", existing.id, {});
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

/** What the sweep found for one recording. */
export type KeepInStepOutcome = "closed" | "corrected" | "unchanged";

/**
 * The sweep's work for one recording, run inside that recording's own tenant:
 * close it if it ran past its limit, otherwise make the stream server hold
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
