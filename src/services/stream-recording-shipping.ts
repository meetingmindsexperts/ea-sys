/**
 * Shipping a recording's pieces from the stream server's buffer to S3
 * (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2, step 2). One
 * recording at a time, inside its own tenant, called every minute by the
 * worker (src/lib/webinar/stream-recording-ship.ts).
 *
 * For each finished piece, oldest first:
 *
 *   1. read it from the buffer folder (mounted read-only into the worker),
 *   2. measure how long it plays (mpegts-duration.ts),
 *   3. upload it to the recording's place in storage,
 *   4. write its row and add it to the recording's totals, in one transaction,
 *   5. ask the stream server to delete it (it wrote the file as root).
 *
 * A crash between any two steps is safe on the next run: the upload goes to
 * the same name, a piece whose row exists is only deleted, and a row is never
 * written twice (one piece's name is unique per recording). Pieces are taken
 * strictly in order and the run stops at the first that fails to SHIP, so a
 * piece is never numbered before one that began earlier. A piece shipped but
 * not deleted does not stop the run: it is already numbered, its delete is
 * tried again next run, and stopping there would leave the rest unshipped
 * until the stream server's own two-hour clean-up deleted them for good.
 *
 * A piece recorded while the organisers said not to record (the stream server
 * told late: recording-pieces.ts, pieceWanted) is deleted and never shipped.
 *
 * Says so, once every ten minutes per recording, when pieces are piling up
 * (shipping is not keeping up, or failing) and when a recording that should be
 * running has produced nothing for two minutes while its stream is live.
 *
 * The stream key is asked of session-stream.ts and used for the folder and the
 * delete only: never stored, returned or logged.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { uploadFile } from "@/lib/storage";
import { deleteRecordingPiece } from "@/lib/webinar/mediamtx-control";
import { mpegtsDurationMs } from "@/lib/webinar/mpegts-duration";
import { recordingsDir } from "@/lib/webinar/recording-disk";
import {
  finishedPieces,
  PIECE_MAX_BYTES,
  PIECE_WAITING_ALERT_MS,
  pieceStart,
  pieceWanted,
  startsBreak,
  type PieceFile,
} from "@/lib/webinar/recording-pieces";
import { sessionStream } from "@/lib/webinar/session-stream";
import { isStreamArriving } from "@/lib/webinar/stream-probe";

export interface ShipReport {
  /** Pieces uploaded and recorded this run. */
  shipped: number;
  /** Pieces deleted without shipping: recorded while the organisers said not to. */
  discarded: number;
  /** Finished pieces still in the buffer after this run. */
  waiting: number;
}

interface At {
  eventId: string;
  sessionId: string;
}

interface Row {
  id: string;
  organizationId: string | null;
  status: "RECORDING" | "PAUSED" | "FINISHING";
  storagePrefix: string;
  lastStartedAt: Date;
  stoppedAt: Date | null;
  finishedAt: Date | null;
}

const SHIPPING = ["RECORDING", "PAUSED", "FINISHING"] as const;

/** How often the same thing is said about the same recording. */
const SAY_EVERY_MS = 10 * 60_000;
const said = new Map<string, number>();
const SAID_MAX = 1000;

/** Test hook. */
export function resetShippingReports(): void {
  said.clear();
}

function sayOnce(what: string, recordingId: string, now: Date, speak: () => void): void {
  const mark = `${what}:${recordingId}`;
  const last = said.get(mark);
  if (last !== undefined && now.getTime() - last < SAY_EVERY_MS) return;
  if (said.size >= SAID_MAX) said.clear();
  said.set(mark, now.getTime());
  speak();
}

async function readRecording(at: At): Promise<Row | null> {
  const row = await db.streamRecording.findFirst({
    where: { sessionId: at.sessionId, eventId: at.eventId, status: { in: [...SHIPPING] } },
    select: { id: true, organizationId: true, status: true, storagePrefix: true, lastStartedAt: true, stoppedAt: true, finishedAt: true },
  });
  return row as Row | null;
}

/** The pieces in this stream's buffer folder, or none when it has none yet. */
async function listPieces(at: At, folder: string): Promise<PieceFile[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (err) {
    // No folder yet: the stream server makes it with the first piece.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    apiLogger.warn({ err, eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:folder-unreadable");
    return [];
  }
  const files: PieceFile[] = [];
  for (const name of names) {
    if (!pieceStart(name)) continue;
    try {
      const info = await stat(path.join(folder, name));
      files.push({ name, bytes: info.size, modifiedAt: info.mtime });
    } catch (err) {
      // Deleted between the listing and the look: nothing to ship.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return files;
}

/** Ask the stream server to remove a piece. False when it did not; said once in ten minutes per recording. */
async function dropPiece(at: At, recordingId: string, streamKey: string, piece: PieceFile, now: Date): Promise<boolean> {
  const start = pieceStart(piece.name);
  if (!start) return false;
  const result = await deleteRecordingPiece(streamKey, start.iso);
  if (result.ok) return true;
  sayOnce("not-deleted", recordingId, now, () =>
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, code: result.code }, "stream-recording-ship:piece-not-deleted"),
  );
  return false;
}

/** Upload one piece and write its row. False when it was not shipped. */
async function shipPiece(at: At, row: Row, folder: string, piece: PieceFile): Promise<boolean> {
  const start = pieceStart(piece.name);
  if (!start) return false;
  if (piece.bytes > PIECE_MAX_BYTES) {
    apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId, bytes: piece.bytes }, "stream-recording-ship:piece-too-large");
    return false;
  }
  const buffer = await readFile(path.join(folder, piece.name));
  const durationMs = mpegtsDurationMs(buffer);
  if (durationMs === null) {
    // Kept all the same: a damaged piece is still part of the programme, and the MP4 step passes over it.
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, bytes: buffer.length }, "stream-recording-ship:piece-length-unreadable");
  }

  const subdirectory = row.storagePrefix.replace(/^\/uploads\//, "");
  const storedPath = await uploadFile(buffer, piece.name, "video/mp2t", subdirectory);
  if (storedPath !== `${row.storagePrefix}/${piece.name}`) {
    throw new Error("stream-recording-ship: a piece was stored somewhere other than its recording's folder");
  }

  try {
    await tenantTransaction(async (tx) => {
      const last = await tx.streamRecordingSegment.findFirst({
        where: { recordingId: row.id },
        orderBy: { seq: "desc" },
        select: { seq: true, startedAt: true, durationMs: true },
      });
      await tx.streamRecordingSegment.create({
        data: {
          recordingId: row.id,
          // Stamped from the recording, as the row policy requires.
          organizationId: row.organizationId,
          seq: last ? last.seq + 1 : 0,
          sourceName: piece.name,
          startedAt: start.at,
          durationMs: durationMs ?? 0,
          bytes: buffer.length,
          storedPath,
          afterBreak: startsBreak(last, start.at),
        },
      });
      await tx.streamRecording.update({
        where: { id: row.id },
        data: {
          segmentCount: { increment: 1 },
          totalBytes: { increment: BigInt(buffer.length) },
          durationMs: { increment: durationMs ?? 0 },
        },
      });
    });
  } catch (err) {
    // Already recorded by an earlier run that stopped before the delete: the outcome wanted.
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  return true;
}

/** Has this piece already been shipped? */
async function alreadyShipped(recordingId: string, name: string): Promise<boolean> {
  const found = await db.streamRecordingSegment.findFirst({ where: { recordingId, sourceName: name }, select: { id: true } });
  return found !== null;
}

/**
 * Ship one finished piece (or delete it, if it is unwanted). False only when it
 * could not be shipped, which stops this recording's run.
 */
async function handlePiece(
  at: At,
  row: Row,
  streamKey: string,
  folder: string,
  piece: PieceFile,
  report: ShipReport,
  now: Date,
): Promise<boolean> {
  const start = pieceStart(piece.name);
  if (!start) return true;
  if (!pieceWanted(row, start.at)) {
    if (await dropPiece(at, row.id, streamKey, piece, now)) report.discarded += 1;
    return true;
  }
  if (!(await alreadyShipped(row.id, piece.name))) {
    if (!(await shipPiece(at, row, folder, piece))) return false;
    report.shipped += 1;
  }
  // Not deleted: the next run sees its row and only tries the delete again.
  await dropPiece(at, row.id, streamKey, piece, now);
  return true;
}

/**
 * Ship every finished piece of this session's recording, until `deadline` (by
 * `clock`). Nothing to do when it has no recording that is shipping, or no
 * partner stream.
 */
export async function shipRecordingPieces(
  at: At,
  opts: { now: Date; deadline: number; clock: () => number },
): Promise<ShipReport> {
  const report: ShipReport = { shipped: 0, discarded: 0, waiting: 0 };
  const row = await readRecording(at);
  if (!row) return report;
  const stream = await sessionStream(at.sessionId, at.eventId);
  // No partner stream: the minute sweep already says so about the recording.
  if (!stream || stream.source !== "external") return report;

  const folder = path.join(recordingsDir(), "live", stream.streamKey);
  const files = await listPieces(at, folder);
  const finished = finishedPieces(files, opts.now);
  let done = 0;
  for (const piece of finished) {
    if (opts.clock() >= opts.deadline) break;
    try {
      if (!(await handlePiece(at, row, stream.streamKey, folder, piece, report, opts.now))) break;
    } catch (err) {
      // Stop at the first failure so no piece is ever numbered ahead of an earlier one.
      apiLogger.error({ err, eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:piece-failed");
      break;
    }
    done += 1;
  }

  const left = finished.slice(done);
  report.waiting = left.length;
  warnIfPiling(at, row, left, opts.now);
  await warnIfNotRecording(at, row, stream.streamKey, files, opts.now);
  return report;
}

/** Finished pieces left over two minutes: shipping is failing or not keeping up. */
function warnIfPiling(at: At, row: Row, left: readonly PieceFile[], now: Date): void {
  if (left.length === 0) return;
  const oldest = Math.min(...left.map((p) => p.modifiedAt.getTime()));
  const ageMs = now.getTime() - oldest;
  if (ageMs < PIECE_WAITING_ALERT_MS) return;
  sayOnce("piling", row.id, now, () =>
    apiLogger.error(
      { eventId: at.eventId, sessionId: at.sessionId, waiting: left.length, oldestSeconds: Math.round(ageMs / 1000) },
      "stream-recording-ship:pieces-waiting",
    ),
  );
}

/**
 * A recording that should be running, nothing new from the stream server for
 * two minutes, and the stream itself live: the stream server is not recording
 * (it restarted and the sweep has not yet put the setting back, or a call
 * failed). The newest piece's last change, or the last Start, is the evidence.
 */
async function warnIfNotRecording(at: At, row: Row, streamKey: string, files: readonly PieceFile[], now: Date): Promise<void> {
  if (row.status !== "RECORDING") return;
  const newest = files.length ? Math.max(...files.map((f) => f.modifiedAt.getTime())) : 0;
  const lastSign = Math.max(newest, row.lastStartedAt.getTime());
  if (now.getTime() - lastSign < PIECE_WAITING_ALERT_MS) return;
  if (!(await isStreamArriving(streamKey))) return;
  sayOnce("not-recording", row.id, now, () =>
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:live-but-not-recording"),
  );
}
