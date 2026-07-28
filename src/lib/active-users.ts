/**
 * "Who is logged in right now."
 *
 * WHY THIS EXISTS RATHER THAN A SESSION LIST
 * ------------------------------------------
 * Sessions here are stateless JWTs (`strategy: "jwt"` in src/lib/auth.ts). The
 * signed token lives in the browser's cookie and the server stores nothing, so
 * there is literally no server-side record of "this person is logged in" to
 * enumerate. (`AuthSession` exists in the schema from the Prisma adapter and is
 * completely unused.)
 *
 * Switching to database sessions would give a true per-device session list and
 * make remote sign-out possible, but it changes how every single request
 * authenticates on a live system, adds a DB read to each one, and signs
 * everyone out on cutover. Last-seen tracking answers the actual question —
 * who is using this right now, and when was each person last active — for a
 * fraction of the risk, and is the column a future "sign out everywhere" would
 * need anyway.
 *
 * THE COST
 * --------
 * Stamping on every request would be one write per request. Instead the stamp
 * piggybacks on the role re-validation block already in the JWT callback, which
 * self-throttles to once per 5 minutes per user. So an active person costs one
 * extra write per 5 minutes, and an idle open tab costs nothing.
 */

import { db } from "@/lib/db";
import { authLogger } from "@/lib/logger";

/**
 * How often `lastSeenAt` is actually written, set by the JWT callback's
 * existing 5-minute role-check throttle in src/lib/auth.ts.
 *
 * This is a DESCRIPTION of that cadence, not a control for it — the two are
 * coupled by the fact that the stamp rides that block. If that interval ever
 * changes, this constant and the window below must move with it.
 */
export const LAST_SEEN_STAMP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How recent `lastSeenAt` must be to count as "online now".
 *
 * MUST be comfortably larger than the stamp interval. At 5-minute granularity,
 * someone who was active 4 minutes ago may have a stamp that is 5 minutes old —
 * with a 5-minute window they would flicker offline while actively using the
 * product. Double it so the display is stable. (Pinned by a test.)
 */
export const LAST_SEEN_ONLINE_WINDOW_MS = 2 * LAST_SEEN_STAMP_INTERVAL_MS;

/** True when this timestamp counts as currently active. */
export function isOnlineNow(lastSeenAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  const age = now.getTime() - lastSeenAt.getTime();
  // A clock-skew future timestamp is still "recent" — negative age passes.
  return age <= LAST_SEEN_ONLINE_WINDOW_MS;
}

/** The cutoff an "online now" query should filter on. */
export function onlineSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - LAST_SEEN_ONLINE_WINDOW_MS);
}

/**
 * When presence tracking started — the deploy that added `User.lastSeenAt`.
 *
 * WHY THIS CONSTANT EXISTS
 * ------------------------
 * Every account started at null and there is no backfill, because the data
 * simply did not exist before. So on day one the card showed "Never" against
 * every colleague, which is indistinguishable from "this account has never been
 * used" — and reads as broken.
 *
 * A null therefore means "not seen SINCE tracking began", not "never". Surfacing
 * the date is what makes that difference visible to whoever is reading the card.
 *
 * Deliberately NOT backfilled from `AuditLog` (the only other per-user
 * timestamp): an audit row means "last time they CHANGED something", which is a
 * different thing from being active — someone who browses daily but last edited
 * a record in April would be shown as four months idle. Wrong numbers that
 * persist are worse than an honest blank that fills in within a day of use.
 */
export const PRESENCE_TRACKING_SINCE = "2026-07-28T07:13:00Z";

/**
 * Record that this account was just active.
 *
 * CONTRACT: never throws, never blocks. Callers fire it without awaiting — it
 * sits on the authentication path, and a presence stamp must never be able to
 * interfere with someone using the product.
 *
 * Uses `updateMany` rather than `update` deliberately: `update` throws P2025
 * when the row is gone, and a deleted account whose JWT has not yet expired
 * would then throw on every single request until it did. `updateMany` matches
 * nothing and returns a count of 0.
 */
export async function touchLastSeen(userId: string): Promise<void> {
  try {
    await db.user.updateMany({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
  } catch (err) {
    authLogger.warn({ err, msg: "active-users:touch-failed", userId });
  }
}
