/**
 * The rules of recording a partner's stream (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md). Pure: no database, no network, so
 * every rule here is tested as arithmetic. The reads and writes are in
 * src/services/stream-recording-service.ts.
 *
 * ONE recording per session, moved through five states:
 *
 *   RECORDING   the stream server is told to record this stream
 *   PAUSED      it is told not to; Start again continues the same recording
 *   FINISHING   closed for good: the last pieces are shipped, the MP4 is made
 *   READY       the MP4 is there
 *   FAILED      it could not be finished; `error` says why
 *
 * Start and Stop only ever move between the first two. Once closed it is
 * never recorded into again: a second recording of the same webinar means
 * deleting the first, on purpose, so two halves are never mistaken for a whole.
 *
 * What the stream server is told follows from the state alone
 * (serverSetting). The minute sweep makes the server agree with it, so a call
 * that failed when a button was pressed, or a server that restarted and forgot
 * its settings, is put right without anyone pressing anything.
 */

export type RecordingStatus = "RECORDING" | "PAUSED" | "FINISHING" | "READY" | "FAILED";
export type RecordingAction = "start" | "stop" | "finish";

export type RecordingRefusal = "NOT_STARTED" | "ALREADY_FINISHED";

export type RecordingTransition =
  /** `changed` false: the recording is already in that state, and nothing is written. */
  | { ok: true; next: RecordingStatus; changed: boolean }
  | { ok: false; code: RecordingRefusal };

/** A recording that still takes Start and Stop. */
export function isRecordingOpen(status: RecordingStatus): boolean {
  return status === "RECORDING" || status === "PAUSED";
}

const OPEN_TARGET: Record<RecordingAction, RecordingStatus> = { start: "RECORDING", stop: "PAUSED", finish: "FINISHING" };

/**
 * Where an action takes a recording. `current` null is a session with no
 * recording yet: only Start makes one. Finish on one already finishing is not
 * an error (the room closing and a person pressing Finish can both arrive).
 */
export function recordingTransition(current: RecordingStatus | null, action: RecordingAction): RecordingTransition {
  if (current === null) {
    if (action !== "start") return { ok: false, code: "NOT_STARTED" };
    return { ok: true, next: "RECORDING", changed: true };
  }
  if (!isRecordingOpen(current)) {
    if (action === "finish" && current === "FINISHING") return { ok: true, next: "FINISHING", changed: false };
    return { ok: false, code: "ALREADY_FINISHED" };
  }
  const next = OPEN_TARGET[action];
  return { ok: true, next, changed: next !== current };
}

/**
 * What the stream server should hold for this stream: record it, hold a
 * setting that says not to, or hold no setting of its own at all.
 */
export type ServerSetting = "record" | "hold" | "none";

export function serverSetting(status: RecordingStatus): ServerSetting {
  if (status === "RECORDING") return "record";
  return status === "PAUSED" ? "hold" : "none";
}

/**
 * The safety net for a recording nobody finishes: six hours after the webinar's
 * scheduled end, or after recording was last started, whichever is later.
 *
 * Counted from the webinar and not from when the recording was made (review of
 * 7563027f7): Start before the stream begins ARMS the recording, and a producer
 * who armed it at nine for a four o'clock webinar found it closed at three.
 * Counted from the last Start as well, so a webinar that runs long after its
 * scheduled end is not cut off while someone is still deliberately recording.
 */
export const RECORDING_MAX_MS = 6 * 60 * 60 * 1000;

export function recordingOverran(recording: { lastStartedAt: Date; sessionEndTime: Date }, now: Date): boolean {
  const from = Math.max(recording.lastStartedAt.getTime(), recording.sessionEndTime.getTime());
  return now.getTime() - from >= RECORDING_MAX_MS;
}

/**
 * Closing the room STOPS the recording; it is finished this long after, unless
 * the room was opened again (review of be8511218, HIGH). A producer who closes
 * by mistake and re-opens a minute later presses Start again and loses
 * nothing, where finishing at once would have ended the recording for good.
 * Ten minutes is past the console's own window to re-open (the thank-you
 * waits five).
 */
export const ROOM_CLOSED_FINISH_GRACE_MS = 10 * 60 * 1000;

/**
 * Whether the sweep finishes a recording because the webinar is over: stopped,
 * its room closed (the session COMPLETED; a rehearsal close puts it back to
 * SCHEDULED), and stopped for the grace. Counted from the stop, which the room
 * closing made, or an earlier one by staff: either way the room is closed now
 * and nobody started it again.
 */
export function finishesAfterRoomClosed(
  recording: { status: RecordingStatus; stoppedAt: Date | null; sessionStatus: string },
  now: Date,
): boolean {
  if (recording.status !== "PAUSED" || recording.sessionStatus !== "COMPLETED" || !recording.stoppedAt) return false;
  return now.getTime() - recording.stoppedAt.getTime() >= ROOM_CLOSED_FINISH_GRACE_MS;
}

/** How long a recording is kept (the owner, Nov 24, 2026: 12 months, changeable per recording). */
export const RECORDING_RETENTION_MONTHS = 12;

/** The day a recording begun on `from` is to be removed. Calendar months, in UTC. */
export function recordingDeleteAfter(from: Date): Date {
  const out = new Date(from.getTime());
  out.setUTCMonth(out.getUTCMonth() + RECORDING_RETENTION_MONTHS);
  return out;
}

/**
 * Where a recording's pieces and its MP4 are stored, as a stored path. Every
 * part is an id we made, checked here so a path can never be steered.
 */
export function recordingStoragePrefix(ids: { eventId: string; sessionId: string; recordingId: string }): string {
  for (const id of [ids.eventId, ids.sessionId, ids.recordingId]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("stream-recording: an id that cannot be part of a path");
  }
  return `/uploads/recordings/${ids.eventId}/${ids.sessionId}/${ids.recordingId}`;
}

/**
 * One pause of a recording: from a Stop to the Start after it, or still open.
 * Kept for every pause (review of 9592d2151): the shipping job discards any
 * piece begun inside one, and knowing only the last let earlier pauses' footage
 * back in. Stored on the recording as JSON (`pauses`), oldest first.
 */
export interface RecordingPause {
  from: Date;
  to: Date | null;
}

/** A recording with more pauses than this is not one a person made; the oldest are dropped. */
export const PAUSES_MAX = 500;

/** The stored list as pauses, leaving out anything that is not one. */
export function readPauses(raw: unknown): RecordingPause[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordingPause[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { from, to } = item as { from?: unknown; to?: unknown };
    const start = typeof from === "string" ? new Date(from) : null;
    if (!start || Number.isNaN(start.getTime())) continue;
    const end = typeof to === "string" ? new Date(to) : null;
    out.push({ from: start, to: end && !Number.isNaN(end.getTime()) ? end : null });
  }
  return out.slice(-PAUSES_MAX);
}

function toJson(pauses: readonly RecordingPause[]): { from: string; to: string | null }[] {
  return pauses.slice(-PAUSES_MAX).map((p) => ({ from: p.from.toISOString(), to: p.to ? p.to.toISOString() : null }));
}

/** The list after a Stop at `at`: a new open pause. */
export function pausesAfterStop(raw: unknown, at: Date): { from: string; to: string | null }[] {
  return toJson([...readPauses(raw), { from: at, to: null }]);
}

/** The list after a Start at `at`: the open pause, if any, closed. */
export function pausesAfterStart(raw: unknown, at: Date): { from: string; to: string | null }[] {
  const pauses = readPauses(raw);
  const last = pauses[pauses.length - 1];
  if (last && last.to === null) last.to = at;
  return toJson(pauses);
}
