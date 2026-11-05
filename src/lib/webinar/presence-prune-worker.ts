import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

/**
 * webinar-presence-prune — retention for the webinar page heartbeats (security review, Nov 5,
 * 2026, W-06).
 *
 * `WebinarPresence` says when a named registrant opened the lobby, last had the page open and how
 * often they rejoined. The only reader is the console's "here now" roster, which looks back 60
 * seconds; the durable "Joined" fact is `Registration.webinarFirstJoinedAt`, and attendance for
 * CME comes from Zoom's report (`ZoomAttendance`). So an old row holds personal activity data and
 * serves nothing. Kept 90 days, long enough to answer "was this person in the lobby?" after an
 * event, then deleted.
 *
 * Self-healing: each tick deletes everything past the cutoff (batched), so a missed run catches up.
 */

export const WEBINAR_PRESENCE_RETENTION_DAYS = 90;

const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_TICK = 20;

export async function runWebinarPresencePruneTick(now: Date = new Date()): Promise<{
  deleted: number;
  capped: boolean;
}> {
  const cutoff = new Date(now.getTime() - WEBINAR_PRESENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let capped = false;

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const rows = await db.webinarPresence.findMany({
      where: { lastSeenAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    const res = await db.webinarPresence.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    deleted += res.count;

    if (rows.length === BATCH_SIZE && batch === MAX_BATCHES_PER_TICK - 1) capped = true;
    if (rows.length < BATCH_SIZE) break;
  }

  if (capped) {
    apiLogger.warn({ deleted, cutoff: cutoff.toISOString() }, "webinar-presence-prune:capped");
  } else {
    apiLogger.info({ deleted, cutoff: cutoff.toISOString() }, "webinar-presence-prune:done");
  }
  return { deleted, capped };
}
