/**
 * Per-request tenant context (multi-tenancy Phase 0 spine).
 *
 * An AsyncLocalStorage store carrying the resolved tenant org through async
 * call chains, read by the Prisma `SET LOCAL` extension in src/lib/db.ts so
 * Postgres RLS policies can filter by `current_setting('app.current_org')`
 * without every query author remembering to pass orgId (defence #2 — app-level
 * `where organizationId` scoping stays defence #1).
 *
 * Status: the CONTACTS domain is wired (Phase-2 pilot, July 2026) — every
 * /api/contacts/* handler + the contact agent executors wrap their body in
 * `runWithTenant(ctx.organizationId, …)` after auth/role guards, and the
 * domain's two interactive transactions use `tenantTransaction`. With
 * RLS_SET_LOCAL unset (master) all of it is a pure passthrough. Other
 * domains remain unwired: wiring each one + migrating its `db.$transaction`
 * sites to `tenantTransaction` (see db.ts) is that domain's Phase-2 sweep —
 * enabling the flag before ALL domains are migrated would mis-scope the
 * remaining ~86 plain `db.$transaction` sites.
 *
 * Deliberately import-free of db.ts/logger (leaf module, no cycles).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantStore {
  orgId: string;
  /**
   * Set while inside `tenantTransaction` — tells the query extension the
   * SET LOCAL has already been issued on this transaction's backend, so
   * individual operations must pass through un-wrapped.
   */
  inTenantTx?: boolean;
}

const als = new AsyncLocalStorage<TenantStore>();

/**
 * Run `fn` with the given tenant org bound to the async context.
 *
 * The async wrapper is LOAD-BEARING: PrismaPromises are lazy (they execute on
 * `await`/`.then`, not on creation), so a shorthand callback like
 * `runWithTenant(org, () => db.event.findMany())` would otherwise return the
 * un-executed thenable, exit the ALS scope, and run the query with NO tenant
 * store — the extension passes through and fail-closed RLS returns zero rows
 * (caught by the tenancy harness). Awaiting inside the `als.run` forces the
 * thenable to begin execution while the context is live; AsyncLocalStorage
 * then propagates through its continuations.
 */
export function runWithTenant<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ orgId }, async () => await fn());
}

export function getTenantStore(): TenantStore | undefined {
  return als.getStore();
}

export function getTenantOrgId(): string | null {
  return als.getStore()?.orgId ?? null;
}

/**
 * Internal (used by db.ts `tenantTransaction`): re-enter the current tenant
 * context with the in-transaction marker set. No-op passthrough when no
 * tenant store is active.
 */
export function enterTenantTx<T>(fn: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return fn();
  // Same lazy-thenable guard as runWithTenant.
  return als.run({ ...store, inTenantTx: true }, async () => await fn());
}
