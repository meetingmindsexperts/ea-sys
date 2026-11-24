/**
 * The worker's shipping run for recordings of a partner's stream (Nov 24,
 * 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md §4.2). Every minute, from the job
 * stream-recording-ship: find the recordings that may have pieces in the
 * stream server's buffer, and ship each one's inside its own tenant
 * (src/services/stream-recording-shipping.ts).
 *
 * Once a minute, not every few seconds: each run writes a JobRun row and a
 * lease, kept 14 days, and the buffer holding a minute of video (about 25 MB
 * per stream) costs nothing. One run stops starting new work after
 * SHIP_BUDGET_MS so it always ends inside the worker's shutdown drain; what is
 * left is shipped by the next run.
 */
import { dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { logSafe, shipRecordingPieces, type ShipReport } from "@/services/stream-recording-shipping";

export const SHIP_BUDGET_MS = 20_000;
/** Far above anything one box records at once. */
const RECORDINGS_MAX = 50;

export interface ShippingRunReport extends ShipReport {
  /** Recordings looked at. */
  recordings: number;
}

export async function shipStreamRecordings(
  now: Date = new Date(),
  opts: { clock?: () => number } = {},
): Promise<ShippingRunReport> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + SHIP_BUDGET_MS;
  const report: ShippingRunReport = { recordings: 0, shipped: 0, discarded: 0, waiting: 0 };
  // Privileged lane: a cross-tenant scan for the recordings to ship; each then runs in its own tenant.
  const rows = await dbOperator.streamRecording.findMany({
    where: { status: { in: ["RECORDING", "PAUSED", "FINISHING"] } },
    select: { eventId: true, sessionId: true, organizationId: true },
    // The most recently started first: today's webinar before an old leftover.
    orderBy: { lastStartedAt: "desc" },
    take: RECORDINGS_MAX,
  });

  for (const row of rows) {
    if (clock() >= deadline) {
      apiLogger.warn({ recordings: report.recordings, left: rows.length - report.recordings }, "stream-recording-ship:out-of-time");
      break;
    }
    report.recordings += 1;
    try {
      const work = () => shipRecordingPieces(row, { now, deadline, clock });
      const one = row.organizationId ? await runWithTenant(row.organizationId, work) : await work();
      report.shipped += one.shipped;
      report.discarded += one.discarded;
      report.waiting += one.waiting;
    } catch (err) {
      // One recording's failure never stops the others.
      // By code only when it is a file error: its path holds the stream key.
      apiLogger.error({ err: logSafe(err), eventId: row.eventId, sessionId: row.sessionId }, "stream-recording-ship:recording-failed");
    }
  }
  return report;
}
