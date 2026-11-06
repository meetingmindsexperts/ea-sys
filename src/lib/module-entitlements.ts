/**
 * PER-ORGANISATION MODULE ENTITLEMENTS (Nov 6, 2026; CRM product review P1-5).
 *
 * THE THIRD QUESTION. module-flags.ts holds two that look alike: TENANCY ("can
 * a tenant have this data?") and AVAILABILITY ("is the module on for this
 * deployment?"). This file holds the third: ENTITLEMENT, "has THIS
 * organisation got the module?". A deployment flag cannot answer it, because
 * one platform deployment serves many organisations and only some of them
 * bought the CRM. And a permission cannot answer it either: `crm.read` says a
 * PERSON may read the board, never that their ORGANISATION has one. Both must
 * hold, and every CRM entry point asks both.
 *
 * STORED in `Organization.enabledModules` (a text array). The migration that
 * added it gave every organisation existing at the time `crm`, so master did
 * not change; an organisation created afterwards starts with NOTHING, which is
 * the fail-closed default the platform needs. Only the platform operator
 * changes it (PUT /api/organizations/[orgId]/modules).
 *
 * SWITCHING A MODULE OFF SUSPENDS, NEVER DELETES. The CRM's routes 404, its
 * workers skip the organisation, its inbound mail waits under held/<org>/ (the
 * worker moves it back to inbound/ by itself once the CRM is on again), and
 * every row stays exactly where it was.
 *
 * "OFF" AND "COULD NOT TELL" ARE DIFFERENT ANSWERS. `orgModuleState` says
 * which; `orgHasModule` folds "unknown" into false for callers that only gate
 * (fail closed). A caller whose "off" branch MOVES something (the inbound
 * worker) must ask the state, or a one-second database blip parks good mail.
 *
 * CACHED for 30 seconds per process: requireCrmRead asks on every CRM request.
 * A change made through the operator route clears this process's entry at
 * once; the other container (blue/green, the worker) catches up within the TTL.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export const ORG_MODULES = ["crm"] as const;
export type OrgModule = (typeof ORG_MODULES)[number];

export function isOrgModule(value: unknown): value is OrgModule {
  return typeof value === "string" && (ORG_MODULES as readonly string[]).includes(value);
}

const TTL_MS = 30_000;
const cache = new Map<string, { modules: readonly string[]; at: number }>();

/** The organisation's enabled modules (empty for an unknown organisation), or null when the read failed. */
async function readModules(organizationId: string): Promise<readonly string[] | null> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules;
  try {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { enabledModules: true } });
    const modules = org?.enabledModules ?? [];
    cache.set(organizationId, { modules, at: Date.now() });
    return modules;
  } catch (err) {
    apiLogger.error({ msg: "module-entitlements:read-failed", organizationId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export type ModuleState = "on" | "off" | "unknown";

/** On, off, or unknown (the read failed: never cached, never treated as off by a caller that moves data). */
export async function orgModuleState(organizationId: string, module: OrgModule): Promise<ModuleState> {
  const modules = await readModules(organizationId);
  if (!modules) return "unknown";
  return modules.includes(module) ? "on" : "off";
}

/** Fail-closed gate: true only when the module is known to be on. */
export async function orgHasModule(organizationId: string, module: OrgModule): Promise<boolean> {
  return (await orgModuleState(organizationId, module)) === "on";
}

/** Drop the cached answer, after a change or in a test. No argument clears all. */
export function forgetOrgModules(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}
