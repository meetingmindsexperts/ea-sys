import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * login-event-prune — retention for the sign-in history.
 *
 * `LoginEvent` records every sign-in ATTEMPT, including failures, so it grows
 * with traffic AND with whatever noise the internet aims at the login page. It
 * also holds personal data — the IP address, an approximate location, and the
 * times a named person was working. Neither of those should accumulate
 * indefinitely.
 *
 * Unlike `email-log-prune`, which nulls one column and keeps the row, this
 * DELETES: an expired sign-in record stripped of its address, location and
 * user would carry no information worth the storage. Retention is 180 days,
 * matching EMAIL_BODY_RETENTION_DAYS so the product has one number to reason
 * about — long enough to investigate a pattern noticed months later, short
 * enough that this isn't a permanent movement log of the team.
 *
 * Self-healing: each tick deletes everything past the cutoff (batched), so a
 * missed run catches up on the next one.
 */

export const LOGIN_EVENT_RETENTION_DAYS = 180;

/** Rows deleted per statement — keeps each batch's lock footprint small. */
const BATCH_SIZE = 1000;
/** Per-tick ceiling so a large backlog can't hold the worker slot for minutes. */
const MAX_BATCHES_PER_TICK = 20;

export async function runLoginEventPruneTick(now: Date = new Date()): Promise<{
  deleted: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - LOGIN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    // Select-then-delete rather than one big deleteMany, so each statement
    // touches a bounded set of rows on the shared production database.
    const rows = await db.loginEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.loginEvent.deleteMany({
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
    apiLogger.info({
      msg: "login-event-prune:tick",
      deleted,
      capped,
      cutoff: cutoff.toISOString(),
      retentionDays: LOGIN_EVENT_RETENTION_DAYS,
    });
  }

  return { deleted, capped };
}
