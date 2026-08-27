/**
 * HR MODULE AVAILABILITY: master silo only (owner decision, Aug 27 2026).
 *
 * THE DISTINCTION THIS FILE EXISTS TO HOLD. Two questions look alike and are
 * not:
 *
 *   1. "Can a tenant other than us have HR data?"  -> TENANCY. Answered yes, in
 *      the schema: every HR table carries organizationId, every write stamps it,
 *      and prisma/rls/*.sql policies exist from day one.
 *   2. "Is the module switched on for them?"       -> AVAILABILITY. Answered no,
 *      by this flag.
 *
 * They are separated because only one of them is reversible. A flag flips in a
 * deploy; a tenant-blind data shape is a migration and a backfill. So the module
 * is built tenant-correct and shipped master-only, which costs nothing now and
 * keeps the option open.
 *
 * FAILS CLOSED. Unset means off, so a new deployment (the platform instance, a
 * DR box, a fresh dev machine) does not acquire an HR module by accident. Only
 * an explicit "true" enables it.
 *
 * NOT DERIVED FROM `PLATFORM_ORG_ID`. Inferring "we are master because
 * PLATFORM_ORG_ID is unset" would couple this module's availability to the
 * platform-detection mechanism, so a change to how silos identify themselves
 * would silently change who has an HR system. One env var, one meaning.
 *
 * ENFORCED IN DEPTH, like every other boundary here:
 *   * API routes 404 when off (404, not 403: a module that is not available
 *     should not announce that it exists).
 *   * src/proxy.ts redirects /hr* when off.
 *   * The sidebar entry is hidden when off.
 *   * HR_USER is not offered in the invite dropdown when off, because a role
 *     that can reach nothing is a support ticket waiting to happen.
 */

/** True when the HR module is switched on for this deployment. */
export function isHrModuleEnabled(): boolean {
  return process.env.HR_MODULE_ENABLED === "true";
}
