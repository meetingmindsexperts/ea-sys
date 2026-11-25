/**
 * Shipping a recording's pieces from the stream server's buffer to S3
 * (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2, step 2). One
 * recording at a time, inside its own tenant, called every minute by the
 * worker (src/lib/webinar/stream-recording-ship.ts).
 *
 * Two passes, so a backlog of deletes can never stop the shipping (review of
 * 9592d2151: deletes that kept timing out took each run's whole time, and the
 * stream server's two-hour clean-up then removed footage never shipped):
 *
 *   1. SHIP, oldest first: read each finished piece from the buffer folder
 *      (mounted read-only into the worker), measure it, upload it, and write
 *      its row with the recording's totals in one transaction. The pass stops
 *      at the first piece that cannot be shipped, so a piece is never numbered
 *      ahead of one that began earlier.
 *   2. DELETE, with the time left: ask the stream server to remove every piece
 *      now in S3, and every piece it recorded while the organisers had
 *      recording stopped (recording-pieces.ts, pieceWanted; never shipped). The
 *      pass stops at the first delete that fails, until the next run.
 *
 * A crash between any two steps is safe on the next run: the upload goes to
 * the same name, a piece whose row exists is only deleted, a row is never
 * written twice (one piece's name is unique per recording).
 *
 * Says so, once every ten minutes per recording and per kind, when pieces pile
 * up unshipped, when deletes fail, when one piece cannot be shipped, and when a
 * recording that should be running has produced nothing for two minutes while
 * its stream is live.
 *
 * The stream key is asked of session-stream.ts and used for the folder and the
 * delete only: never stored, returned or logged. The folder's path holds it,
 * and Node's file errors repeat their path, so a file error is logged by its
 * code alone (logSafe).
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
  fallbackPieceMs,
  finishedPieces,
  PIECE_MAX_BYTES,
  PIECE_WAITING_ALERT_MS,
  pieceStart,
  pieceWanted,
  startsBreak,
  type PieceFile,
} from "@/lib/webinar/recording-pieces";
import { readPauses, type RecordingPause } from "@/lib/webinar/stream-recording";
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
  startedAt: Date;
  lastStartedAt: Date;
  finishedAt: Date | null;
  pauses: RecordingPause[];
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

/**
 * An error as it may be logged here. A file error (it has a `syscall`) repeats
 * the path it failed on, and every path in the buffer holds the stream key:
 * only its code and call are kept (review of 9592d2151). Anything else is
 * logged whole.
 */
export function logSafe(err: unknown): unknown {
  const e = err as NodeJS.ErrnoException | null;
  if (e && typeof e === "object" && typeof e.syscall === "string") return { code: e.code, syscall: e.syscall };
  return err;
}

async function readRecording(at: At): Promise<Row | null> {
  const row = await db.streamRecording.findFirst({
    where: { sessionId: at.sessionId, eventId: at.eventId, status: { in: [...SHIPPING] } },
    select: {
      id: true,
      organizationId: true,
      status: true,
      storagePrefix: true,
      startedAt: true,
      lastStartedAt: true,
      finishedAt: true,
      pauses: true,
    },
  });
  if (!row) return null;
  return { ...row, status: row.status as Row["status"], pauses: readPauses(row.pauses) };
}

/** The pieces in this stream's buffer folder, or none when it has none yet. */
async function listPieces(at: At, folder: string): Promise<PieceFile[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (err) {
    // No folder yet: the stream server makes it with the first piece.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    apiLogger.warn({ err: logSafe(err), eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:folder-unreadable");
    return [];
  }
  const files: PieceFile[] = [];
  for (const name of names) {
    if (!pieceStart(name)) continue;
    try {
      const info = await stat(path.join(folder, name));
      files.push({ name, bytes: info.size, modifiedAt: info.mtime });
    } catch (err) {
      // Deleted between the listing and the look: nothing to ship. Anything else is logged by code only.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      apiLogger.warn({ err: logSafe(err), eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:piece-unreadable");
    }
  }
  return files;
}

interface Previous {
  seq: number;
  startedAt: Date;
  durationMs: number;
}

async function lastShipped(recordingId: string): Promise<Previous | null> {
  return db.streamRecordingSegment.findFirst({
    where: { recordingId },
    orderBy: { seq: "desc" },
    select: { seq: true, startedAt: true, durationMs: true },
  });
}

/** Which of these pieces already have a row: one question for the whole folder. */
async function shippedNames(recordingId: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const rows = await db.streamRecordingSegment.findMany({
    where: { recordingId, sourceName: { in: names } },
    select: { sourceName: true },
  });
  return new Set(rows.map((r) => r.sourceName));
}

type ShipOutcome = "shipped" | "failed" | "discard";

/** Upload one piece and write its row. */
async function shipPiece(at: At, row: Row, folder: string, piece: PieceFile, next: PieceFile | null, now: Date): Promise<ShipOutcome> {
  const start = pieceStart(piece.name);
  if (!start) return "failed";
  if (piece.bytes > PIECE_MAX_BYTES) {
    // Eight seconds at over 100 Mbps is not a piece of a webinar: it is dropped, not left to hold up the rest.
    sayOnce("too-large", row.id, now, () =>
      apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId, bytes: piece.bytes }, "stream-recording-ship:piece-too-large"),
    );
    return "discard";
  }
  const buffer = await readFile(path.join(folder, piece.name));
  let durationMs = mpegtsDurationMs(buffer) ?? 0;
  if (durationMs === 0) {
    const nextStart = next ? (pieceStart(next.name)?.at ?? null) : null;
    durationMs = fallbackPieceMs(start.at, nextStart);
    // Kept all the same: a damaged piece is still part of the programme.
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId, bytes: buffer.length, durationMs }, "stream-recording-ship:piece-length-unreadable");
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
          durationMs,
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
          durationMs: { increment: durationMs },
        },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    // A unique row already there. Only THIS piece's row means it is recorded (review of 9592d2151): a
    // clash on the number would mean it is not, and deleting it then would lose it.
    const mine = await shippedNames(row.id, [piece.name]);
    if (!mine.has(piece.name)) throw err;
  }
  return "shipped";
}

/** Pass 1: ship the wanted pieces not yet shipped, in order; collect what the stream server may delete. */
async function shipPass(
  at: At,
  row: Row,
  folder: string,
  finished: PieceFile[],
  opts: { now: Date; deadline: number; clock: () => number },
): Promise<{ shipped: number; unshipped: PieceFile[]; toDelete: { piece: PieceFile; discard: boolean }[] }> {
  const done = await shippedNames(
    row.id,
    finished.map((p) => p.name),
  );
  let previous = await lastShipped(row.id);
  const toDelete: { piece: PieceFile; discard: boolean }[] = [];
  const unshipped: PieceFile[] = [];
  let shipped = 0;
  let stopped = false;
  for (let i = 0; i < finished.length; i++) {
    const piece = finished[i];
    const start = pieceStart(piece.name);
    if (!start) continue;
    if (done.has(piece.name)) {
      toDelete.push({ piece, discard: false });
      continue;
    }
    if (!pieceWanted(row, start.at)) {
      toDelete.push({ piece, discard: true });
      continue;
    }
    if (previous && start.at.getTime() < previous.startedAt.getTime()) {
      // Never number a piece behind one already shipped (review of 9592d2151). It cannot be put in its place.
      sayOnce("out-of-order", row.id, opts.now, () =>
        apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:piece-out-of-order"),
      );
      toDelete.push({ piece, discard: true });
      continue;
    }
    if (stopped || opts.clock() >= opts.deadline) {
      stopped = true;
      unshipped.push(piece);
      continue;
    }
    let outcome: ShipOutcome;
    try {
      outcome = await shipPiece(at, row, folder, piece, finished[i + 1] ?? null, opts.now);
    } catch (err) {
      sayOnce("ship-failed", row.id, opts.now, () =>
        apiLogger.error({ err: logSafe(err), eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:piece-failed"),
      );
      outcome = "failed";
    }
    if (outcome === "discard") {
      toDelete.push({ piece, discard: true });
      continue;
    }
    if (outcome === "failed") {
      // Stop shipping so nothing is numbered ahead of this piece; the rest wait for the next run.
      stopped = true;
      unshipped.push(piece);
      continue;
    }
    shipped += 1;
    previous = { seq: (previous?.seq ?? -1) + 1, startedAt: start.at, durationMs: 0 };
    toDelete.push({ piece, discard: false });
  }
  return { shipped, unshipped, toDelete };
}

/** Pass 2: have the stream server delete, with the time left; stop at the first failure. Returns how many unwanted went. */
async function deletePass(
  at: At,
  row: Row,
  streamKey: string,
  toDelete: { piece: PieceFile; discard: boolean }[],
  opts: { now: Date; deadline: number; clock: () => number },
): Promise<number> {
  let discarded = 0;
  for (const { piece, discard } of toDelete) {
    if (opts.clock() >= opts.deadline) return discarded;
    const start = pieceStart(piece.name);
    if (!start) continue;
    const result = await deleteRecordingPiece(streamKey, start.iso);
    if (!result.ok) {
      // Tried again next run. Said once in ten minutes, not once per piece.
      sayOnce("not-deleted", row.id, opts.now, () =>
        apiLogger.warn(
          { eventId: at.eventId, sessionId: at.sessionId, code: result.code, pending: toDelete.length },
          "stream-recording-ship:piece-not-deleted",
        ),
      );
      return discarded;
    }
    if (discard) discarded += 1;
  }
  return discarded;
}

/**
 * Ship every finished piece of this session's recording, then delete what may
 * go, until `deadline` (by `clock`). Nothing to do when it has no recording
 * that is shipping, or no partner stream.
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

  // Asked once: whether the newest piece may still be open, and whether nothing is being recorded.
  const live = row.status === "RECORDING" ? await isStreamArriving(stream.streamKey) : false;
  const folder = path.join(recordingsDir(), "live", stream.streamKey);
  const files = await listPieces(at, folder);
  const finished = finishedPieces(files, opts.now, { newestMayBeOpen: live });

  const shipped = await shipPass(at, row, folder, finished, opts);
  report.shipped = shipped.shipped;
  report.waiting = shipped.unshipped.length;
  report.discarded = await deletePass(at, row, stream.streamKey, shipped.toDelete, opts);

  warnIfPiling(at, row, shipped.unshipped, opts.now);
  warnIfNotRecording(at, row, live, files, opts.now);
  return report;
}

/**
 * How many pieces of a FINISHING recording are still to reach storage: the
 * finishing job joins the MP4 only at zero (step 4, Nov 25, 2026). Counts
 * every piece in the buffer the recording wants and has no row for, settled
 * or not: a piece still being written will be wanted too. Null when it cannot
 * be told (the session has no partner stream any more, so its buffer folder
 * cannot be named): the caller decides then by time alone.
 */
export async function piecesLeftToShip(at: At): Promise<number | null> {
  const row = await readRecording(at);
  if (!row) return 0;
  const stream = await sessionStream(at.sessionId, at.eventId);
  if (!stream || stream.source !== "external") return null;
  const files = await listPieces(at, path.join(recordingsDir(), "live", stream.streamKey));
  const wanted = files.filter((f) => {
    const start = pieceStart(f.name);
    return start !== null && pieceWanted(row, start.at);
  });
  const done = await shippedNames(
    row.id,
    wanted.map((f) => f.name),
  );
  return wanted.filter((f) => !done.has(f.name)).length;
}

/** Wanted pieces left unshipped over two minutes: shipping is failing or not keeping up. */
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
function warnIfNotRecording(at: At, row: Row, live: boolean, files: readonly PieceFile[], now: Date): void {
  if (row.status !== "RECORDING" || !live) return;
  const newest = files.length ? Math.max(...files.map((f) => f.modifiedAt.getTime())) : 0;
  const lastSign = Math.max(newest, row.lastStartedAt.getTime());
  if (now.getTime() - lastSign < PIECE_WAITING_ALERT_MS) return;
  sayOnce("not-recording", row.id, now, () =>
    apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-ship:live-but-not-recording"),
  );
}
