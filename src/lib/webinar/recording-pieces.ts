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
 *
 * `newestMayBeOpen`: the stream is live and being recorded, so the newest piece
 * is the one the stream server is writing even if it has not grown for a while
 * (a sender that stalls without disconnecting; review of 9592d2151). Shipped
 * and deleted then, the rest of it would be written into a file already gone.
 */
export function finishedPieces(files: readonly PieceFile[], now: Date, opts: { newestMayBeOpen?: boolean } = {}): PieceFile[] {
  const pieces = files
    .map((file) => ({ file, start: pieceStart(file.name) }))
    .filter((p): p is { file: PieceFile; start: PieceStart } => p.start !== null)
    .sort((a, b) => a.start.order - b.start.order)
    .map((p) => p.file);
  if (pieces.length === 0) return [];
  const newest = pieces[pieces.length - 1];
  const settled = !opts.newestMayBeOpen && now.getTime() - newest.modifiedAt.getTime() >= PIECE_SETTLED_MS;
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
 * Whether a piece was recorded while the organisers said to record: it began
 * after the recording did, not after it was finished, and not inside any of its
 * pauses (an open pause runs on). Such a piece exists only when the stream
 * server was told late (a call that failed, a race with the minute sweep): it
 * is deleted, never shipped.
 *
 * Every pause is asked, not only the last (review of 9592d2151): an unwanted
 * piece whose delete failed is still in the folder on the next run, and judged
 * against the last pause alone it became wanted after a later Stop and was
 * shipped, out of order, into the client's archive. A piece older than the
 * recording is a leftover under the same key, never its first piece.
 */
export function pieceWanted(
  recording: { startedAt: Date; finishedAt: Date | null; pauses: readonly { from: Date; to: Date | null }[] },
  pieceStartedAt: Date,
): boolean {
  const t = pieceStartedAt.getTime();
  if (t < recording.startedAt.getTime() - EDGE_MS) return false;
  if (recording.finishedAt && t > recording.finishedAt.getTime() + EDGE_MS) return false;
  for (const pause of recording.pauses) {
    const from = pause.from.getTime() + EDGE_MS;
    const to = pause.to ? pause.to.getTime() - EDGE_MS : Infinity;
    if (t > from && t < to) return false;
  }
  return true;
}

/**
 * A piece's length when its own timestamps could not be read: the gap to the
 * next piece's start, at most a long piece's length; nothing to go by without a
 * next piece. Kept so one damaged piece does not read as a break after it.
 */
export const FALLBACK_PIECE_MAX_MS = 10_000;

export function fallbackPieceMs(startedAt: Date, nextStartedAt: Date | null): number {
  if (!nextStartedAt) return 0;
  const gap = nextStartedAt.getTime() - startedAt.getTime();
  return gap > 0 ? Math.min(gap, FALLBACK_PIECE_MAX_MS) : 0;
}

/** A piece that is still waiting to be shipped after this long means shipping is not keeping up. */
export const PIECE_WAITING_ALERT_MS = 2 * 60_000;

/** A piece larger than this is not shipped (eight seconds at 100 Mbps): something is wrong with it. */
export const PIECE_MAX_BYTES = 100 * 1024 * 1024;
