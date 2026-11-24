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
 * the minute sweep (convergeStreamRecordings, from the stream watchdog job)
 * makes the server agree. The same sweep covers a stream server that restarted
 * and forgot its settings, and closes a recording nobody finished.
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
  organizationId: string | null;
  /** Null when the system acts. */
  userId: string | null;
  source: StreamRecordingSource;
}

export type StreamRecordingErrorCode =
  | "NOT_AVAILABLE"
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
  segmentCount: true,
  totalBytes: true,
  durationMs: true,
  archivePath: true,
  archiveBytes: true,
  error: true,
  deleteAfter: true,
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
  segmentCount: number;
  totalBytes: bigint;
  durationMs: number;
  archivePath: string | null;
  archiveBytes: bigint | null;
  error: string | null;
  deleteAfter: Date | null;
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
  apiLogger.warn({ eventId: caller.eventId, sessionId: caller.sessionId, userId: caller.userId, code }, `stream-recording:${op}-refused`);
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
async function answer(caller: Caller, fallback: Row): Promise<StreamRecordingResult> {
  const row = (await readRow(caller)) ?? fallback;
  const streamKey = await partnerKey(caller);
  if (!streamKey) {
    apiLogger.warn({ eventId: caller.eventId, sessionId: caller.sessionId }, "stream-recording:no-partner-stream-to-tell");
    return { ok: true, recording: toView(row), server: NO_STREAM };
  }
  return { ok: true, recording: toView(row), server: toOutcome(await tellServer(caller, streamKey, row.status)) };
}

async function createRecording(input: Caller, now: Date): Promise<Row | null> {
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
export async function startStreamRecording(input: Caller & { partnerAgreed?: boolean; now?: Date }): Promise<StreamRecordingResult> {
  if (!streamRecordingAvailable()) return refuse(input, "start", "NOT_AVAILABLE");
  if (!(await partnerKey(input))) return refuse(input, "start", "NOT_PARTNER_STREAM");
  const now = input.now ?? new Date();

  const existing = await readRow(input);
  const step = recordingTransition(existing?.status ?? null, "start");
  if (!step.ok) return refuse(input, "start", step.code);

  if (!existing) {
    if (input.partnerAgreed !== true) return refuse(input, "start", "AGREEMENT_REQUIRED");
    const created = await createRecording(input, now);
    if (!created) {
      // Lost the race to another Start: answer with theirs, which is the same recording.
      const theirs = await readRow(input);
      if (!theirs) throw new Error("stream-recording: the session's recording exists and cannot be read");
      return answer(input, theirs);
    }
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:started");
    await audit(input, "STREAM_RECORDING_STARTED", created.id, { partnerAgreed: true });
    return answer(input, created);
  }

  if (step.changed && (await move(existing, { status: "RECORDING", lastStartedAt: now }))) {
    apiLogger.info({ eventId: input.eventId, sessionId: input.sessionId, userId: input.userId }, "stream-recording:resumed");
    await audit(input, "STREAM_RECORDING_RESUMED", existing.id, {});
  }
  return answer(input, existing);
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
  return answer(input, existing);
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
  if (step.changed && (await move(existing, { status: "FINISHING", stoppedAt: existing.stoppedAt ?? now, finishedAt: now }))) {
    apiLogger.info(
      { eventId: input.eventId, sessionId: input.sessionId, userId: input.userId, reason: input.reason },
      "stream-recording:finishing",
    );
    await audit(input, "STREAM_RECORDING_FINISHED", existing.id, { reason: input.reason });
  }
  return answer(input, existing);
}

// ── The minute sweep ──

/** A recording closed this recently still has its setting cleared again, in case the first clear failed. */
const CLEAR_AGAIN_FOR_MS = 60 * 60 * 1000;
/** Far above anything one box records at once, and a bound on one sweep. */
const SWEEP_MAX = 200;

export interface RecordingSweepReport {
  /** Recordings looked at. */
  checked: number;
  /** Times the stream server had to be put right. */
  corrected: number;
  /** Recordings closed because they ran past their limit. */
  closed: number;
}

/** Recordings without a partner stream already reported, so each is said once, not every minute. */
const reportedWithoutStream = new Set<string>();

/** Test hook. */
export function resetStreamRecordingSweep(): void {
  reportedWithoutStream.clear();
}

async function sweepOne(row: Row, now: Date, report: RecordingSweepReport): Promise<void> {
  const at: Caller = { eventId: row.eventId, sessionId: row.sessionId, organizationId: row.organizationId, userId: null, source: "worker" };
  if (isRecordingOpen(row.status) && recordingOverran(row.startedAt, now)) {
    apiLogger.warn({ eventId: row.eventId, sessionId: row.sessionId }, "stream-recording:closed-after-limit");
    await finishStreamRecording({ ...at, reason: "overran", now });
    report.closed += 1;
    return;
  }
  const streamKey = await partnerKey(at);
  if (!streamKey) {
    if (reportedWithoutStream.has(row.id)) return;
    if (reportedWithoutStream.size >= SWEEP_MAX) reportedWithoutStream.clear();
    reportedWithoutStream.add(row.id);
    apiLogger.warn({ eventId: row.eventId, sessionId: row.sessionId, status: row.status }, "stream-recording:recording-without-partner-stream");
    return;
  }
  const result = await tellServer(at, streamKey, row.status);
  if (!result.ok || !result.changed) return;
  // The server did not hold what the recording says: a call that failed when the button was pressed, or a restart.
  report.corrected += 1;
  apiLogger.warn({ eventId: row.eventId, sessionId: row.sessionId, status: row.status }, "stream-recording:server-setting-put-right");
}

/**
 * Make the stream server agree with every recording that is open, clear the
 * setting of one closed in the last hour, and close any that ran past its
 * limit. Called every minute by the stream watchdog job. Does nothing while
 * the control API is not set up. Reads across organisations without a tenant
 * in scope, like the partner stream sweep beside it (and with the same limit
 * on an instance with row policies: ROADMAP, "Webinar streaming", item 2).
 */
export async function convergeStreamRecordings(now: Date = new Date()): Promise<RecordingSweepReport> {
  const report: RecordingSweepReport = { checked: 0, corrected: 0, closed: 0 };
  if (!isMediamtxControlConfigured()) return report;
  const rows = await db.streamRecording.findMany({
    where: {
      OR: [
        { status: { in: ["RECORDING", "PAUSED"] } },
        { status: { in: ["FINISHING", "READY", "FAILED"] }, finishedAt: { gte: new Date(now.getTime() - CLEAR_AGAIN_FOR_MS) } },
      ],
    },
    select: ROW_SELECT,
    orderBy: { startedAt: "asc" },
    take: SWEEP_MAX,
  });
  for (const row of rows) {
    report.checked += 1;
    try {
      await sweepOne(row, now, report);
    } catch (err) {
      // One recording's failure never stops the others.
      apiLogger.error({ err, eventId: row.eventId, sessionId: row.sessionId }, "stream-recording:sweep-failed");
    }
  }
  return report;
}
