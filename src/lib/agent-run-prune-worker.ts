import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * agent-run-prune — retention for the Event Agent's stored runs.
 *
 * `AgentRun` and `AgentStep` hold names, counts, tokens and outcomes for every
 * in-app agent request (docs/AGENT_ARCHITECTURE_REVIEW.md §4.6), and since
 * Sep 21, 2026 (owner decision) the message, the agent's reply and each tool
 * call's input as well, which can name attendees. This sweep is what keeps
 * that from becoming a permanent record.
 *
 * This DELETES runs older than the cutoff; their steps go with them through
 * the FK's ON DELETE CASCADE, so one statement per batch removes both. The
 * retention is 180 days, the same number `email-log-prune` and
 * `login-event-prune` use, so the product has one figure to reason about.
 *
 * Self-healing: each tick deletes everything past the cutoff (batched), so a
 * missed run catches up on the next one.
 */

export const AGENT_RUN_RETENTION_DAYS = 180;

/** Rows deleted per statement — keeps each batch's lock footprint small. */
const BATCH_SIZE = 1000;
/** Per-tick ceiling so a large backlog can't hold the worker slot for minutes. */
const MAX_BATCHES_PER_TICK = 20;

export async function runAgentRunPruneTick(now: Date = new Date()): Promise<{
  deleted: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - AGENT_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    // Select-then-delete rather than one big deleteMany, so each statement
    // touches a bounded set of rows on the shared production database.
    const rows = await db.agentRun.findMany({
      where: { startedAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.agentRun.deleteMany({
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
      msg: "agent-run-prune:tick",
      deleted,
      capped,
      cutoff: cutoff.toISOString(),
      retentionDays: AGENT_RUN_RETENTION_DAYS,
    });
  }

  return { deleted, capped };
}
