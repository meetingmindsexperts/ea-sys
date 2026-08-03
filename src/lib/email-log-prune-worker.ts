import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * email-log-prune — retention for the sent-email audit copies.
 *
 * Since July 16, 2026 EVERY send stores its final rendered HTML on
 * `EmailLog.htmlBody` (owner decision: the Activity view must show exactly
 * what was sent). Bulk sends make that a real storage cost — a
 * 2,000-recipient blast is roughly 60–160MB of rendered HTML — so bodies are
 * pruned after EMAIL_BODY_RETENTION_DAYS: `htmlBody` is set back to null and
 * the log row itself (to/subject/status/provider id) is kept forever. The
 * Activity timeline's "View email" action simply disappears for pruned rows
 * (`hasBody` flips false); nothing else changes.
 *
 * Self-healing: each tick prunes ALL rows past the cutoff (batched), so a
 * missed run catches up on the next one.
 *
 * Tenancy (Domain #18): this maintenance sweep is deliberately ORG-BLIND —
 * retention applies to every tenant's rows plus the NULL-org auth-email rows,
 * so per-tenant lanes are the wrong shape here. Under platform RLS as the
 * app role it would silently see zero rows and STOP PRUNING (unbounded
 * htmlBody growth) — the documented cross-sweep worker precondition
 * (MULTI_TENANCY.md §13): the platform must run this job on a privileged
 * maintenance lane. For THIS table that lane is MANDATORY, not a nicety:
 * NULL-org rows are unreadable/undeletable from every tenant lane by design
 * (the asymmetric policy), so this job is the ONLY reaper the null pool has —
 * and tenant offboarding compounds it (EmailLog's org FK is SetNull, so a
 * deleted org's whole email log — recipient addresses + stored htmlBody —
 * falls into that pool; the purge-vs-Cascade decision is recorded in
 * ROADMAP §"Comms-log sweep — deferred decisions"). No-op concern on master
 * (RLS never enabled there).
 */

export const EMAIL_BODY_RETENTION_DAYS = 180;

/** Rows nulled per updateMany batch — keeps each statement's row-lock
 *  footprint small on the shared prod DB. */
const BATCH_SIZE = 1000;
/** Per-tick ceiling so a huge backlog (first run, missed months) can't hold
 *  the worker slot for minutes — the remainder is picked up next tick. */
const MAX_BATCHES_PER_TICK = 20;

export async function runEmailLogPruneTick(now: Date = new Date()): Promise<{
  pruned: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - EMAIL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let pruned = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const rows = await db.emailLog.findMany({
      where: { createdAt: { lt: cutoff }, htmlBody: { not: null } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.emailLog.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { htmlBody: null },
    });
    pruned += res.count;

    if (rows.length === BATCH_SIZE && batch === MAX_BATCHES_PER_TICK - 1) {
      // No silent caps: the backlog outran this tick's budget — say so.
      capped = true;
    }
    if (rows.length < BATCH_SIZE) break;
  }

  if (pruned > 0 || capped) {
    apiLogger.info({
      msg: "email-log-prune:tick",
      pruned,
      capped,
      cutoff: cutoff.toISOString(),
      retentionDays: EMAIL_BODY_RETENTION_DAYS,
    });
  }

  return { pruned, capped };
}
