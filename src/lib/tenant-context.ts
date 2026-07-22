/**
 * Per-request tenant context (multi-tenancy Phase 0 spine).
 *
 * An AsyncLocalStorage store carrying the resolved tenant org through async
 * call chains, read by the Prisma `SET LOCAL` extension in src/lib/db.ts so
 * Postgres RLS policies can filter by `current_setting('app.current_org')`
 * without every query author remembering to pass orgId (defence #2 — app-level
 * `where organizationId` scoping stays defence #1).
 *
 * Phase-0 status: NOTHING in production populates this store — only the
 * tenant-isolation harness (tests/tenancy) runs inside `runWithTenant`, and
 * the extension is additionally gated by RLS_SET_LOCAL=1 (unset on master).
 * Wiring `getOrgContext`/route handlers into `runWithTenant` is Phase-2 work,
 * gated on migrating interactive transactions to `tenantTransaction` (see
 * db.ts) — enabling the flag before that migration would mis-scope the ~88
 * existing `db.$transaction` sites.
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
