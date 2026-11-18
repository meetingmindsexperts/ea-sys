import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks database work as the alert system's OWN bookkeeping (the `AlertState`
 * reads and writes that decide whether an alert email goes out).
 *
 * WHY. An error line becomes an alert, and before an alert is sent the alert
 * path reads its bookkeeping table. If that read fails, and the failure is
 * logged as an error like any other, the alert path is asked to alert about
 * its own failed read, which reads again, which fails again. Nothing ends it:
 * about 150 log lines a second on Nov 18, 2026, when a test server was started
 * with no database. On production the same loop would start on a wrong or
 * rotated database password, or the day the app's role lost its grant on that
 * one table, and would fill the disk in hours.
 *
 * So the Prisma error handler in db.ts asks `isAlertBookkeeping()` and logs
 * such a failure below the alerting level. It is asked through the async
 * context, not by looking at the query: the three raw statements in
 * `claimAlertSend` reach the handler as `$queryRaw` with an error text that
 * need not name the table (a missing database, a refused password).
 *
 * HOW FAR THE MARK CAN BE TRUSTED (review of 2b8a7b08). Prisma has two sources
 * for its error event. A failed REQUEST is emitted by the client, inside the
 * caller's async context: for those the mark is exact, and a query that fails
 * elsewhere at the same moment is not touched (checked against a real
 * Postgres). An ENGINE log line is emitted through a callback that carries the
 * context the client was BUILT in, whatever is running now. Two rules follow,
 * and both are load-bearing:
 *   - the client must never be built inside a marked scope, or every engine
 *     error for the life of the process would carry the mark and stop
 *     alerting. `claimAlertSend` therefore loads db.ts BEFORE it enters one;
 *   - the handler honours the mark only for a client call (`isClientCall`).
 *     An engine line's target is a Rust module path and is never downgraded.
 *
 * The store is kept on globalThis, as tenant-context.ts keeps its own: outside
 * production the Prisma client is cached there across reloads, so its handler
 * would otherwise read the store of an older copy of this module.
 *
 * This file imports nothing of ours on purpose: db.ts and admin-alert.ts both
 * need it, and admin-alert.ts may not import db.ts at load.
 */
const globalForBookkeeping = globalThis as unknown as { __eaSysAlertBookkeeping?: AsyncLocalStorage<true> };
const bookkeeping = (globalForBookkeeping.__eaSysAlertBookkeeping ??= new AsyncLocalStorage<true>());

export function inAlertBookkeeping<T>(work: () => Promise<T>): Promise<T> {
  // Awaited INSIDE the scope. A Prisma query is lazy: it is sent when it is
  // awaited, not when it is made, so handing back the bare promise would send
  // the query after the scope had ended and the mark would be gone (the same
  // trap as a tenant lane, found by this file's own test).
  return bookkeeping.run(true, async () => await work());
}

export function isAlertBookkeeping(): boolean {
  return bookkeeping.getStore() === true;
}

/**
 * Is this error event's target a call made through the client (`event.findFirst`,
 * `$queryRaw`), as opposed to a line from the engine (a Rust module path such
 * as `quaint::connector`)? Unknown is treated as "not a client call": the safe
 * side is to go on alerting.
 */
export function isClientCall(target: string | undefined): boolean {
  return !!target && !target.includes("::");
}
