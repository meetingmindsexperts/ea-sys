/**
 * Shadow detector for Event queries made outside a tenant lane (Event RLS
 * preparation, step 3, Nov 5 2026).
 *
 * THE QUESTION IT ANSWERS. Before the Event policy can be switched on, every
 * read of Event must either run inside `runWithTenant(...)` or go through the
 * sanctioned discovery in src/lib/tenant/event-tenant.ts. Anything else returns
 * null under the policy, so its route answers 404 with nothing in the logs. A
 * grep can count the obvious shapes, but it cannot see a library helper called
 * from an unwrapped route. Real traffic can. This records each call site that
 * reads Event with no lane, once, so a week of production plus an e2e run is an
 * inventory instead of an estimate.
 *
 * WHY IT WORKS ON MASTER. RLS is off on master (`RLS_SET_LOCAL` unset), but
 * `runWithTenant` still binds the org into AsyncLocalStorage on every wrapped
 * path. So "no tenant store at query time" means the same thing here as it
 * will on the platform: this query would fail closed.
 *
 * COST AND SAFETY. Off unless `RLS_SHADOW=1`; when off it is one env read and
 * one string compare per query. When on, a stack trace is taken only for an
 * unlaned Event query, each call site logs ONCE per process (a bounded set), and
 * every failure inside is swallowed, because an observer must never break the
 * query it is observing. It changes no behaviour and blocks nothing.
 *
 * WHAT IT CANNOT SEE: `$queryRaw` against Event, and Event read as a nested
 * relation of another model's query. Under RLS both fail closed too, so the
 * sandbox rehearsal with the pilot policy remains the final check.
 *
 * Reading the output: `tenant:event-query-no-lane` lines carry `operation`,
 * `route` (the route or page file that made the query; it keeps its path in a
 * production build) and `callsite` (the first application frames). One line
 * per operation per route, so a helper used by many routes shows under each.
 */
// Relative, like db.ts and the modules it pulls in: this file is imported by db.ts.
import { AsyncLocalStorage } from "node:async_hooks";
import { dbLogger } from "../logger";
import { getTenantOrgId } from "../tenant-context";

/** Distinct call sites reported per process before the detector goes quiet. */
export const SHADOW_MAX_SITES = 500;

/**
 * Prisma's own frames fill the default 10-frame stack before any application
 * frame appears, so the capture asks for more. Only paid on an unlaned Event
 * query with the flag on.
 */
const STACK_DEPTH = 60;

const seen = new Set<string>();
let capped = false;

/**
 * Marks the sanctioned discovery read (src/lib/tenant/event-tenant.ts) so it is
 * not reported. A context flag rather than a file-name match, because in a
 * production bundle the frames carry chunk names, not source paths.
 */
const discovery = new AsyncLocalStorage<true>();

/** Run `fn` as the sanctioned pre-lane Event discovery read. */
export function asEventDiscovery<T>(fn: () => Promise<T>): Promise<T> {
  // Awaited inside the scope for the same lazy-thenable reason as runWithTenant.
  return discovery.run(true, async () => await fn());
}

/** Frames that belong to the plumbing, not to the code that made the query. */
const PLUMBING = /node_modules|node:internal|lane-shadow|\/lib\/db\.|tenant-context|\$allOperations|<anonymous>/;

/**
 * A route or page frame: `src/app/...` from source, `server/app/...` from a
 * build. The fallback when Next's request store is unavailable.
 */
const ROUTE_FRAME = /(?:src|server)\/app\//;

type RouteStore = { getStore(): { route?: string } | undefined };
/** undefined: not looked up yet. null: unavailable (worker, script, a Next upgrade moved it). */
let routeStore: RouteStore | null | undefined;

/**
 * The route Next.js is serving, e.g. `/api/public/events/[slug]/register`.
 *
 * WHY NOT THE STACK. Prisma runs the query extension from its own promise
 * machinery after the caller's `await`, so the caller's frames are never on the
 * stack: in a build only the extension's own chunk is left. Next keeps the
 * route in its per-request AsyncLocalStorage, which survives that hop.
 *
 * It is a private Next module, so it is loaded lazily, once, and any failure
 * leaves the detector working with `route: null`. It must never be able to
 * break the import of db.ts, which is why this is not a static import.
 */
function currentRoute(): string | null {
  if (routeStore === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      routeStore = require("next/dist/server/app-render/work-async-storage.external").workAsyncStorage ?? null;
    } catch {
      // Not inside Next (worker, scripts) or the module moved; the stack fallback still applies.
      routeStore = null;
    }
  }
  return routeStore?.getStore()?.route ?? null;
}

function frames(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .filter((line) => line && !PLUMBING.test(line));
}

function captureStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_DEPTH;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * Called from the tenant query extension for every model operation. Reports an
 * Event query that runs with no tenant lane. Never throws.
 */
export function noteUnlanedEventQuery(model: string | undefined, operation: string): void {
  if (process.env.RLS_SHADOW !== "1" || model !== "Event") return;
  try {
    if (getTenantOrgId()) return;
    if (discovery.getStore()) return;
    if (capped) return;
    const app = frames(captureStack());
    const route = currentRoute() ?? app.find((f) => ROUTE_FRAME.test(f)) ?? null;
    const callsite = app.length ? app.slice(0, 3).join(" < ") : "unknown";
    const key = `${operation}|${route ?? callsite}`;
    if (seen.has(key)) return;
    if (seen.size >= SHADOW_MAX_SITES) {
      capped = true;
      dbLogger.info({ msg: "tenant:event-shadow-capped", sites: seen.size });
      return;
    }
    seen.add(key);
    dbLogger.info({ msg: "tenant:event-query-no-lane", operation, route, callsite });
  } catch (err) {
    // An observer must never break the query it observes. Log and carry on.
    try {
      dbLogger.warn({ err, msg: "tenant:event-shadow-failed" });
    } catch {
      // The logger itself failed; there is nothing further to report to.
    }
  }
}

/** Test seam: forget every reported call site. */
export function resetLaneShadowForTests(): void {
  seen.clear();
  capped = false;
}
