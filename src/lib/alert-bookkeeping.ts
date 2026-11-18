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
 * need not name the table (a missing database, a refused password). Prisma
 * emits its error event inside the caller's async context (checked against a
 * real Postgres when this was written), so the mark is exact: a query that
 * fails elsewhere at the same moment is not touched.
 *
 * This file imports nothing of ours on purpose: db.ts and admin-alert.ts both
 * need it, and admin-alert.ts may not import db.ts at load.
 */
const bookkeeping = new AsyncLocalStorage<true>();

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
