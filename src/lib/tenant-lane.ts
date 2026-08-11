/**
 * `runWithTenantLane` — enter a tenant's lane, and say something when there
 * isn't one.
 *
 * THE SHAPE THIS REPLACES. Forty-five call sites across the Phase-2 sweeps
 * wrote `runWithTenant(orgId ?? "", …)`. The empty string is not a lane: under
 * platform RLS `current_setting('app.current_org')` never matches, so every
 * query inside returns nothing and the handler answers 404 or an empty list.
 * That is the SAFE direction, and it was chosen deliberately. The problem is
 * that it is also a SILENT direction. Nothing is logged, so on the platform an
 * operator would meet a 404 with no way to tell "this row does not exist" from
 * "you have no lane to see it through".
 *
 * WHAT WE DECIDED (multi-tenancy item 5, owner, Aug 11 2026). Keep failing
 * closed, but make it legible. An org-null caller on a tenant-scoped route is
 * the platform operator reaching into a tenant's event, and the answer to that
 * is a membership in the tenant, not a privilege escalation in the route. This
 * deliberately does NOT reach for `dbOperator`: check-in, refunds, credit
 * notes and badge printing are exactly the handlers you least want running
 * with RLS switched off.
 *
 * Note the §4 correction this encodes. The original plan was to fall back to
 * the default (operator) org id instead of an empty string. That does not
 * work: the operator org's lane cannot read tenant ACME's registration either,
 * so it swaps one dead lane for another while looking like a fix. The org
 * stamped on a row IS the lane that can read it, which is also why the
 * ownerless-row decision went to a synthetic platform org rather than to MMG's.
 *
 * BEHAVIOUR ON MASTER IS UNCHANGED, and that is load-bearing: `RLS_SET_LOCAL`
 * is off, so `runWithTenant` is a passthrough for any value including "". An
 * org-null SUPER_ADMIN keeps working exactly as they do today. The only thing
 * this adds on master is one warn line.
 */

import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";

/**
 * Run `fn` inside `orgId`'s tenant lane.
 *
 * When `orgId` is absent, logs `tenant:no-org-lane` with the route and caller
 * and proceeds on an empty lane, which resolves no rows under RLS and is a
 * passthrough on master.
 *
 * `route` is required rather than optional, unlike the `route` on
 * `denyReviewer`. That guard sits on ~212 call sites where most can never be
 * reached by a restricted role; this one is only ever placed where an org-null
 * caller is genuinely possible, so a line that names WHO but not WHAT would be
 * useless every single time it fired. On Aug 10 an optional route field cost a
 * five-step deduction to place 51 warnings, and that is the lesson being
 * applied here rather than repeated.
 */
export function runWithTenantLane<T>(
  orgId: string | null | undefined,
  ctx: { route: string; userId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!orgId) {
    apiLogger.warn({
      msg: "tenant:no-org-lane",
      route: ctx.route,
      userId: ctx.userId ?? null,
    });
    return runWithTenant("", fn);
  }
  return runWithTenant(orgId, fn);
}
