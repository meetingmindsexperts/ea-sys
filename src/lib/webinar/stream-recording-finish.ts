/**
 * The worker's run that makes the MP4 of each finished recording of a
 * partner's stream (Nov 25, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.4,
 * step 4). Every minute, from the job stream-recording-finish: find the
 * FINISHING recordings, oldest finish first, and make each one's file inside
 * its own tenant (src/services/stream-recording-archive.ts).
 *
 * No time budget of its own: a two hour webinar takes a minute or two, and the
 * job's lease is renewed while it runs. A worker stopped mid-way (a deploy)
 * leaves no half-written file kept, and the next run starts that recording
 * again.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { buildRecordingArchive, type ArchiveOutcome } from "@/services/stream-recording-archive";

/** Far above anything one box finishes at once. */
const RECORDINGS_MAX = 20;

export type FinishRunReport = Record<ArchiveOutcome, number> & { checked: number; errors: number };

export async function finishStreamRecordingArchives(now: Date = new Date()): Promise<FinishRunReport> {
  const report: FinishRunReport = { checked: 0, errors: 0, skipped: 0, waiting: 0, ready: 0, empty: 0, retry: 0, failed: 0 };
  // Privileged lane: a cross-tenant scan for the recordings to finish; each then runs in its own tenant.
  const rows = await dbOperator.streamRecording.findMany({
    where: { status: "FINISHING" },
    select: { eventId: true, sessionId: true, organizationId: true },
    orderBy: { finishedAt: "asc" },
    take: RECORDINGS_MAX,
  });
  for (const row of rows) {
    report.checked += 1;
    try {
      const work = () => buildRecordingArchive(row, now);
      const outcome = row.organizationId ? await runWithTenant(row.organizationId, work) : await work();
      report[outcome] += 1;
    } catch (err) {
      // One recording's failure never stops the others.
      report.errors += 1;
      apiLogger.error({ err, eventId: row.eventId, sessionId: row.sessionId }, "stream-recording-finish:recording-failed");
    }
  }
  return report;
}
