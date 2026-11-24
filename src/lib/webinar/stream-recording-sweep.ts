/**
 * The minute sweep behind recording a partner's stream (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md §4.1). From the worker's stream
 * watchdog job, every minute:
 *
 *   - a recording that is open (RECORDING or PAUSED): make the stream server
 *     hold what it says. This is what puts right a call that failed when a
 *     button was pressed, and a stream server that restarted and forgot;
 *   - a recording that is closed and whose setting has not yet been CONFIRMED
 *     removed from the stream server: remove it, until that is confirmed
 *     (review of 7563027f7: it used to try for one hour and then give up, and
 *     a setting saying "record" could outlive its recording);
 *   - a recording past its limit: close it.
 *
 * This file only finds WHICH recordings to look at, across organisations, in
 * the privileged lane. What to do with each is decided by the service from a
 * fresh read, inside that recording's own tenant
 * (keepRecordingInStep, src/services/stream-recording-service.ts): the list
 * made here is a minute old by the time its last row is reached, and acting on
 * it undid a Stop pressed meanwhile.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { isMediamtxControlConfigured } from "@/lib/webinar/mediamtx-control";
import { keepRecordingInStep } from "@/services/stream-recording-service";

/** Far above anything one box records at once, and a bound on one sweep. */
const SWEEP_MAX = 200;
/**
 * One sweep stops starting new work after this long and leaves the rest to the
 * next minute. Each recording can cost a few calls of up to three seconds, and
 * the job this runs in must end inside the worker's shutdown drain.
 */
export const SWEEP_BUDGET_MS = 10_000;

export interface RecordingSweepReport {
  /** Recordings looked at. */
  checked: number;
  /** Open recordings whose stream server setting had to be put right. */
  corrected: number;
  /** Recordings closed because they ran past their limit. */
  closed: number;
}

export async function convergeStreamRecordings(
  now: Date = new Date(),
  opts: { clock?: () => number } = {},
): Promise<RecordingSweepReport> {
  const clock = opts.clock ?? Date.now;
  const began = clock();
  const report: RecordingSweepReport = { checked: 0, corrected: 0, closed: 0 };
  // Privileged lane: a cross-tenant scan for the recordings to look at; each then runs in its own tenant.
  const rows = await dbOperator.streamRecording.findMany({
    where: {
      OR: [
        { status: { in: ["RECORDING", "PAUSED"] } },
        { status: { in: ["FINISHING", "READY", "FAILED"] }, serverClearedAt: null },
      ],
    },
    select: { eventId: true, sessionId: true, organizationId: true },
    // Open and most recently started first, so old leftovers never push today's webinar past the cap.
    orderBy: [{ status: "asc" }, { lastStartedAt: "desc" }],
    take: SWEEP_MAX,
  });
  const serverReachable = isMediamtxControlConfigured();

  for (const row of rows) {
    if (clock() - began >= SWEEP_BUDGET_MS) {
      apiLogger.warn({ checked: report.checked, waiting: rows.length - report.checked }, "stream-recording-sweep:out-of-time");
      break;
    }
    report.checked += 1;
    try {
      const work = () => keepRecordingInStep(row, now, serverReachable);
      const outcome = row.organizationId ? await runWithTenant(row.organizationId, work) : await work();
      if (outcome === "corrected") report.corrected += 1;
      if (outcome === "closed") report.closed += 1;
    } catch (err) {
      // One recording's failure never stops the others.
      apiLogger.error({ err, eventId: row.eventId, sessionId: row.sessionId }, "stream-recording-sweep:recording-failed");
    }
  }
  return report;
}
