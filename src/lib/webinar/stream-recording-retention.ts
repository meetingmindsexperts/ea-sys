/**
 * The daily clean-up of recordings of a partner's stream (Nov 25, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md D4, step 4), from the job
 * stream-recording-retention:
 *
 *   1. Recordings past `deleteAfter` (12 months, D4) are deleted, row and
 *      files, through the same deleteStreamRecording staff use.
 *   2. Files under `recordings/` that no recording claims are deleted, once a
 *      day old: deleting an event or a session removes its recording's rows by
 *      cascade and leaves the files, and a file a delete could not remove is
 *      left for this.
 *
 * Each recording is worked in its own tenant; the scans are in the privileged
 * lane, since an organisation's files carry no tenant of their own.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { deleteStoredFiles, listStoredFiles } from "@/lib/storage";
import { runWithTenant } from "@/lib/tenant-context";
import { UPLOAD_PREFIX, UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { deleteStreamRecording } from "@/services/stream-recording-service";

/** A file younger than this is never taken for an orphan: its recording's row may be moments old. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Recordings deleted for age in one run; the rest go the next day. */
const EXPIRED_MAX = 200;

export interface RetentionReport {
  expired: number;
  expiredFailed: number;
  orphanFiles: number;
  orphanFilesLeft: number;
}

/** `/uploads/recordings/{event}/{session}/{recording}/{file}` -> the recording's id, or null for anything else. */
export function recordingIdOf(storedPath: string): string | null {
  const rest = storedPath.slice(UPLOAD_PREFIX.recordings.length).split("/");
  return rest.length === 4 && rest[2] ? rest[2] : null;
}

async function deleteExpired(now: Date, report: RetentionReport): Promise<void> {
  const rows = await dbOperator.streamRecording.findMany({
    where: { status: { in: ["READY", "FAILED"] }, deleteAfter: { lt: now } },
    select: { eventId: true, sessionId: true, organizationId: true },
    orderBy: { deleteAfter: "asc" },
    take: EXPIRED_MAX,
  });
  for (const row of rows) {
    try {
      const work = () => deleteStreamRecording({ ...row, userId: null, source: "worker", reason: "retention" });
      const result = row.organizationId ? await runWithTenant(row.organizationId, work) : await work();
      if (result.ok) report.expired += 1;
      else report.expiredFailed += 1;
    } catch (err) {
      report.expiredFailed += 1;
      apiLogger.error({ err, eventId: row.eventId, sessionId: row.sessionId }, "stream-recording-retention:delete-failed");
    }
  }
}

async function deleteOrphans(now: Date, report: RetentionReport): Promise<void> {
  const files = await listStoredFiles(UPLOAD_SEGMENT.recordings);
  const old = files.filter((f) => now.getTime() - f.modifiedAt.getTime() >= ORPHAN_MIN_AGE_MS);
  const ids = [...new Set(old.map((f) => recordingIdOf(f.storedPath)).filter((id): id is string => id !== null))];
  const claimed = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await dbOperator.streamRecording.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true } });
    for (const r of rows) claimed.add(r.id);
  }
  // A file whose path is not a recording's shape is never deleted here: it is not ours to judge.
  const orphans = old.filter((f) => {
    const id = recordingIdOf(f.storedPath);
    return id !== null && !claimed.has(id);
  });
  if (orphans.length === 0) return;
  const { failed } = await deleteStoredFiles(
    orphans.map((f) => f.storedPath),
    UPLOAD_PREFIX.recordings,
  );
  report.orphanFiles = orphans.length;
  report.orphanFilesLeft = failed;
  apiLogger.info({ files: orphans.length, failed }, "stream-recording-retention:orphans-deleted");
}

export async function runStreamRecordingRetention(now: Date = new Date()): Promise<RetentionReport> {
  const report: RetentionReport = { expired: 0, expiredFailed: 0, orphanFiles: 0, orphanFilesLeft: 0 };
  await deleteExpired(now, report);
  await deleteOrphans(now, report);
  return report;
}
