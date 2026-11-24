/**
 * The pieces a recording is made of, as the stream server leaves them in its
 * buffer folder (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2).
 * Pure: the folder is read, and the pieces shipped, by
 * src/services/stream-recording-shipping.ts.
 *
 * A piece is one MPEG-TS file named by when it began, in Unix time with
 * microseconds (`1795512296-718063.ts`; mediamtx.yml recordPath `%s-%f`). The
 * same instant, written as the stream server writes it in its own API
 * (`2026-11-24T09:24:56.718063Z`), is how a piece is asked to be deleted: the
 * stream server finds the file by it, so it must be exact to the microsecond.
 */

export const PIECE_NAME = /^(\d{9,12})-(\d{6})\.ts$/;

export interface PieceFile {
  name: string;
  bytes: number;
  modifiedAt: Date;
}

export interface PieceStart {
  /** When the piece began, to the millisecond. */
  at: Date;
  /** The same instant to the microsecond, as the stream server's API writes it. */
  iso: string;
  /** Sortable: seconds and microseconds as one number. */
  order: number;
}

/** When a piece began, from its name, or null for a file that is not a piece. */
export function pieceStart(name: string): PieceStart | null {
  const m = PIECE_NAME.exec(name);
  if (!m) return null;
  const seconds = Number(m[1]);
  const micros = Number(m[2]);
  const at = new Date(seconds * 1000 + Math.floor(micros / 1000));
  const iso = new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, `.${m[2]}Z`);
  return { at, iso, order: seconds * 1_000_000 + micros };
}

/**
 * A piece still being written is the newest one, and is written to about once
 * a second. Unchanged for this long, the newest is finished too: the stream
 * stopped, or recording did.
 */
export const PIECE_SETTLED_MS = 20_000;

/**
 * The pieces that are finished, oldest first: every piece but the newest, and
 * the newest once it has not changed for PIECE_SETTLED_MS. Files that are not
 * pieces are left out.
 */
export function finishedPieces(files: readonly PieceFile[], now: Date): PieceFile[] {
  const pieces = files
    .map((file) => ({ file, start: pieceStart(file.name) }))
    .filter((p): p is { file: PieceFile; start: PieceStart } => p.start !== null)
    .sort((a, b) => a.start.order - b.start.order)
    .map((p) => p.file);
  if (pieces.length === 0) return [];
  const newest = pieces[pieces.length - 1];
  const settled = now.getTime() - newest.modifiedAt.getTime() >= PIECE_SETTLED_MS;
  return settled ? pieces : pieces.slice(0, -1);
}

/** A gap between one piece's end and the next one's start longer than this is a break in the recording. */
export const BREAK_AFTER_MS = 1_000;

/**
 * Whether a piece does not follow straight on from the one before it: the
 * stream dropped, or recording was stopped. The first piece follows nothing.
 */
export function startsBreak(previous: { startedAt: Date; durationMs: number } | null, startedAt: Date): boolean {
  if (!previous) return false;
  return startedAt.getTime() - (previous.startedAt.getTime() + previous.durationMs) > BREAK_AFTER_MS;
}

/** Slack between our clock and the moment the stream server opens or closes a piece. */
const EDGE_MS = 2_000;

/**
 * Whether a piece was recorded while the organisers said to record. A piece is
 * NOT wanted when it began after the recording was finished, after it was
 * stopped while it is still stopped, or inside the last pause of a recording
 * that was started again. Such a piece exists only when the stream server was
 * told late (a call that failed, a race with the minute sweep): it is deleted,
 * never shipped. Only the last pause is known, which is enough because pieces
 * are shipped within a minute of being written.
 */
export function pieceWanted(
  recording: {
    status: "RECORDING" | "PAUSED" | "FINISHING";
    lastStartedAt: Date;
    stoppedAt: Date | null;
    finishedAt: Date | null;
  },
  pieceStartedAt: Date,
): boolean {
  const t = pieceStartedAt.getTime();
  if (recording.status === "FINISHING") return !recording.finishedAt || t <= recording.finishedAt.getTime() + EDGE_MS;
  const stopped = recording.stoppedAt?.getTime() ?? null;
  if (recording.status === "PAUSED") return stopped === null || t <= stopped + EDGE_MS;
  const restarted = recording.lastStartedAt.getTime();
  const pausedInBetween = stopped !== null && stopped < restarted;
  return !(pausedInBetween && t > stopped + EDGE_MS && t < restarted - EDGE_MS);
}

/** A piece that is still waiting to be shipped after this long means shipping is not keeping up. */
export const PIECE_WAITING_ALERT_MS = 2 * 60_000;

/** A piece larger than this is not shipped (eight seconds at 100 Mbps): something is wrong with it. */
export const PIECE_MAX_BYTES = 100 * 1024 * 1024;
