import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * analytics-prune — retention for measured page hits.
 *
 * `AnalyticsEvent` is the highest-write table in the system: one row per public
 * pageview, so it grows with traffic and never stops. Retention is not optional
 * here, it is what keeps the table a fixed size rather than a slowly worsening
 * query.
 *
 * WHY 400 DAYS AND NOT 180 LIKE THE OTHER SWEEPS
 * The sign-in history and stored email bodies are retained for 180 days because
 * they hold personal data and the question they answer ("what happened
 * recently?") has a short horizon. Traffic measurement is the opposite: the
 * most valuable comparison is this September against last September, which a
 * 365-day window cannot express because the older side has just expired. 400
 * gives a full year-over-year comparison with a month of margin.
 *
 * That longer window is affordable precisely because the rows are NOT personal
 * data. There is no IP column, no user id, and the visitor hash is unlinkable
 * across days once its salt has rotated, so an old row is a count and nothing
 * more. If that ever changes, this number has to come down with it.
 *
 * Deletes rather than nulls a column: a hit stripped of its path and visitor
 * would carry nothing worth storing.
 *
 * Self-healing: each tick deletes everything past the cutoff (batched), so a
 * missed run catches up on the next one.
 */

export const ANALYTICS_RETENTION_DAYS = 400;

/** Rows deleted per statement — keeps each batch's lock footprint small. */
const BATCH_SIZE = 1000;
/**
 * Per-tick ceiling so a large backlog cannot hold the worker slot for minutes.
 * Higher than the other sweeps because this table produces far more rows a day,
 * and a cap that can never catch up is a cap that quietly does nothing.
 */
const MAX_BATCHES_PER_TICK = 50;

export async function runAnalyticsPruneTick(now: Date = new Date()): Promise<{
  deleted: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    // Select-then-delete rather than one large deleteMany, so each statement
    // touches a bounded set of rows on the shared production database.
    const rows = await db.analyticsEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.analyticsEvent.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    deleted += res.count;

    if (rows.length === BATCH_SIZE && batch === MAX_BATCHES_PER_TICK - 1) {
      // No silent caps: the backlog outran this tick's budget, so say so
      // rather than reporting a clean sweep.
      capped = true;
    }
    if (rows.length < BATCH_SIZE) break;
  }

  if (deleted > 0 || capped) {
    apiLogger.info(
      { deleted, capped, cutoff: cutoff.toISOString(), retentionDays: ANALYTICS_RETENTION_DAYS },
      "analytics-prune:swept",
    );
  }
  return { deleted, capped };
}
