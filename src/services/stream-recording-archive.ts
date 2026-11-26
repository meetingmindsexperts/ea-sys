/**
 * Making the MP4 of a finished recording (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4, step 4). Run by the worker's
 * stream-recording-finish job for each FINISHING recording, inside that
 * recording's own tenant.
 *
 * Waits until every piece the recording wants is in storage (the shipping job
 * moves the last ones within a minute or two of the finish), then joins them
 * through ffmpeg into `{storagePrefix}/recording.mp4` (recording-mp4.ts) and
 * marks the recording READY. The join writes the MP4 to the worker's disk
 * first (a plain MP4, since Nov 26, 2026), so it waits while the disk has no
 * room for it beside the stream server's buffer margin. Pieces still not in storage half an hour after
 * the finish are given up on: the MP4 is made from what arrived, and the gap
 * is logged as an error.
 *
 * A join that fails for a storage reason is tried again on the next run; one
 * where ffmpeg itself refuses, or anything still failing six hours after the
 * finish, marks the recording FAILED with the reason, for staff to see and
 * delete. A recording with no pieces at all is READY with no file ("nothing
 * was recorded").
 *
 * Errors are values; a database error throws, to the job's own catch.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { deleteStoredFile, readStoredFile, StorageError, writeStoredFileStream } from "@/lib/storage";
import { UPLOAD_PREFIX } from "@/lib/upload-prefixes";
import { freeDiskBytes, RECORDING_MIN_FREE_BYTES } from "@/lib/webinar/recording-disk";
import { joinPiecesToMp4, Mp4JoinError, removeLeftoverJoinFolders, type SpawnFfmpeg } from "@/lib/webinar/recording-mp4";
import { piecesLeftToShip } from "@/services/stream-recording-shipping";

/** The last piece settles for 20 seconds and the shipping job runs each minute: nothing is joined sooner. */
export const ARCHIVE_MIN_WAIT_MS = 90_000;
/** Pieces still not in storage this long after the finish are given up on, and the MP4 made from the rest. */
export const ARCHIVE_WAIT_MAX_MS = 30 * 60_000;
/** A join still failing this long after the finish marks the recording FAILED. */
export const ARCHIVE_GIVE_UP_MS = 6 * 60 * 60_000;

export const ARCHIVE_FILE_NAME = "recording.mp4";

export type ArchiveOutcome = "skipped" | "waiting" | "ready" | "empty" | "retry" | "failed";

interface At {
  eventId: string;
  sessionId: string;
}

/**
 * How many bytes the disk is short of for making this MP4, or 0 when it has
 * room: the file is about the size of its pieces, and the stream server's
 * buffer keeps its own margin (RECORDING_MIN_FREE_BYTES) on the same disk.
 * Free space that cannot be read is not a reason to wait (it is logged by
 * freeDiskBytes): waiting would end in FAILED six hours later for no cause.
 */
export function archiveDiskShortBy(pieceBytes: bigint, free: number | null): number {
  if (free === null) return 0;
  const need = Number(pieceBytes) + RECORDING_MIN_FREE_BYTES;
  return Math.max(0, need - free);
}

/** Where a recording's MP4 is stored. */
export function archivePathFor(storagePrefix: string): string {
  return `${storagePrefix}/${ARCHIVE_FILE_NAME}`;
}

/** The reason a recording failed, as staff read it; never a path or the stream key. */
function failureText(err: Mp4JoinError): string {
  if (err.kind === "ffmpeg") return "The recording's file could not be made from its pieces.";
  if (err.kind === "timeout" || err.kind === "killed") return "Making the recording's file was stopped before it finished.";
  return "The recording's pieces could not be read or its file written to storage.";
}

async function setOutcome(
  row: { id: string },
  data: { status: "READY" | "FAILED"; archivePath?: string | null; archiveBytes?: bigint | null; error?: string | null },
): Promise<boolean> {
  // Only from FINISHING: a recording deleted meanwhile is not brought back.
  const { count } = await db.streamRecording.updateMany({ where: { id: row.id, status: "FINISHING" }, data });
  return count === 1;
}

async function audit(row: { id: string; organizationId: string | null }, at: At, action: string, changes: Record<string, unknown>) {
  try {
    await db.auditLog.create({
      data: {
        ...(row.organizationId ? { organizationId: row.organizationId } : {}),
        eventId: at.eventId,
        action,
        entityType: "StreamRecording",
        entityId: row.id,
        changes: { ...changes, sessionId: at.sessionId, source: "worker" },
      },
    });
  } catch (err) {
    apiLogger.error({ err, eventId: at.eventId, action }, "stream-recording-archive:audit-failed");
  }
}

/**
 * Make one recording's MP4 if it is time. `spawn` is a test seam for ffmpeg.
 */
export async function buildRecordingArchive(at: At, now: Date, opts: { spawn?: SpawnFfmpeg } = {}): Promise<ArchiveOutcome> {
  const row = await db.streamRecording.findFirst({
    where: { sessionId: at.sessionId, eventId: at.eventId, status: "FINISHING" },
    select: { id: true, organizationId: true, storagePrefix: true, finishedAt: true, totalBytes: true },
  });
  if (!row || !row.finishedAt) return "skipped";
  const sinceFinish = now.getTime() - row.finishedAt.getTime();
  if (sinceFinish < ARCHIVE_MIN_WAIT_MS) return "waiting";

  const left = await piecesLeftToShip(at);
  if (left !== null && left > 0) {
    if (sinceFinish < ARCHIVE_WAIT_MAX_MS) return "waiting";
    apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId, left }, "stream-recording-archive:joined-without-some-pieces");
  }

  const pieces = await db.streamRecordingSegment.findMany({
    where: { recordingId: row.id },
    orderBy: { seq: "asc" },
    select: { storedPath: true },
  });
  if (pieces.length === 0) {
    if (await setOutcome(row, { status: "READY", archivePath: null, archiveBytes: null, error: null })) {
      apiLogger.warn({ eventId: at.eventId, sessionId: at.sessionId }, "stream-recording-archive:nothing-recorded");
      await audit(row, at, "STREAM_RECORDING_READY", { pieces: 0 });
    }
    return "empty";
  }

  await removeLeftoverJoinFolders();
  const shortBy = archiveDiskShortBy(row.totalBytes, await freeDiskBytes());
  if (shortBy > 0) {
    const giveUp = sinceFinish >= ARCHIVE_GIVE_UP_MS;
    apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId, shortBy, giveUp }, "stream-recording-archive:disk-short");
    if (!giveUp) return "retry";
    if (await setOutcome(row, { status: "FAILED", error: "The server had no disk space to make the recording's file." })) {
      await audit(row, at, "STREAM_RECORDING_FAILED", { kind: "disk" });
    }
    return "failed";
  }

  const archivePath = archivePathFor(row.storagePrefix);
  const began = Date.now();
  let missing = 0;
  // A piece whose file is gone from storage is left out, and the MP4 made from the rest (review of 593a7f31a):
  // retrying could never bring it back.
  const readPiece = async (i: number, signal: AbortSignal) => {
    try {
      return await readStoredFile(pieces[i].storedPath, UPLOAD_PREFIX.recordings, { signal });
    } catch (err) {
      if (!(err instanceof StorageError) || err.reason !== "not-found") throw err;
      missing += 1;
      return Buffer.alloc(0);
    }
  };
  try {
    const written = await joinPiecesToMp4({
      count: pieces.length,
      readPiece,
      write: (mp4, signal) => writeStoredFileStream(mp4, archivePath, UPLOAD_PREFIX.recordings, "video/mp4", { signal }),
      spawn: opts.spawn,
    });
    if (missing > 0) {
      apiLogger.error({ eventId: at.eventId, sessionId: at.sessionId, missing, of: pieces.length }, "stream-recording-archive:pieces-missing-from-storage");
    }
    if (!(await setOutcome(row, { status: "READY", archivePath, archiveBytes: BigInt(written.bytes), error: null }))) {
      // Deleted while the file was being made: the file is not left behind.
      await deleteStoredFile(archivePath, UPLOAD_PREFIX.recordings);
      return "skipped";
    }
    apiLogger.info(
      { eventId: at.eventId, sessionId: at.sessionId, pieces: pieces.length, bytes: written.bytes, ms: Date.now() - began },
      "stream-recording-archive:ready",
    );
    await audit(row, at, "STREAM_RECORDING_READY", { pieces: pieces.length, bytes: written.bytes });
    return "ready";
  } catch (err) {
    // A half-written file (ffmpeg stopped after some output) is never kept.
    await deleteStoredFile(archivePath, UPLOAD_PREFIX.recordings);
    const joinErr = err instanceof Mp4JoinError ? err : new Mp4JoinError((err as Error).message, "write");
    const giveUp = joinErr.kind === "ffmpeg" || sinceFinish >= ARCHIVE_GIVE_UP_MS;
    apiLogger.error(
      { err: joinErr.message, kind: joinErr.kind, eventId: at.eventId, sessionId: at.sessionId, giveUp },
      "stream-recording-archive:join-failed",
    );
    if (!giveUp) return "retry";
    if (await setOutcome(row, { status: "FAILED", error: failureText(joinErr) })) {
      await audit(row, at, "STREAM_RECORDING_FAILED", { kind: joinErr.kind });
    }
    return "failed";
  }
}
