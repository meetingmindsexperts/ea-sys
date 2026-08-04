import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * system-log-prune — retention for the SystemLog table.
 *
 * SystemLog exists so the /admin/infra cards (error trend, abuse & auth) and
 * the /logs database source have something to read on EC2 — the logger's
 * warn+ DB stream (Aug 4, 2026) writes it from BOTH the web and worker
 * containers. Log lines are operational exhaust, not records: 30 days is
 * plenty to spot a trend, and the durable copies live in the log files,
 * CloudWatch (90d on the error group) and Sentry.
 *
 * Like login-event-prune this DELETES rows (a pruned log line carries
 * nothing worth keeping); batched + per-tick capped, self-healing (a missed
 * run catches up next tick), and loudly reports when the backlog outruns
 * the per-tick budget (no silent caps).
 */

export const SYSTEM_LOG_RETENTION_DAYS = 30;

/** Rows deleted per statement — keeps each batch's lock footprint small. */
const BATCH_SIZE = 1000;
/** Per-tick ceiling so a large backlog can't hold the worker slot for minutes. */
const MAX_BATCHES_PER_TICK = 20;

export async function runSystemLogPruneTick(now: Date = new Date()): Promise<{
  deleted: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - SYSTEM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    // Select-then-delete rather than one big deleteMany, so each statement
    // touches a bounded set of rows on the shared production database.
    const rows = await db.systemLog.findMany({
      where: { timestamp: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.systemLog.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    deleted += res.count;

    if (rows.length === BATCH_SIZE && batch === MAX_BATCHES_PER_TICK - 1) {
      // No silent caps: the backlog outran this tick's budget — say so.
      capped = true;
    }
    if (rows.length < BATCH_SIZE) break;
  }

  if (deleted > 0 || capped) {
    apiLogger.info(
      { msg: "system-log-prune:tick", deleted, capped, cutoff: cutoff.toISOString() },
      "SystemLog retention sweep",
    );
  }
  return { deleted, capped };
}
