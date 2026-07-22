/**
 * Tenant-scoped where-fragment builder for PUBLIC event-by-slug lookups
 * (multi-tenancy Phase 0 spine — docs/MULTI_TENANCY.md §0).
 *
 * `Event.slug` is only unique PER ORG (`@@unique([organizationId, slug])`), so
 * any public lookup by slug alone is tenant-ambiguous. Every public route must
 * build its event `where` through this helper, which resolves the tenant from
 * the request's Host header (src/lib/tenant/resolver.ts) and binds
 * `organizationId` accordingly:
 *
 *   - resolved tenant        → { organizationId, slug, ... }
 *   - unscoped (master today, pre-seeding) → the LEGACY where, byte-identical
 *     to the pre-tenancy hand-rolled shape — zero behavior change
 *   - unknown host under TENANCY_ENFORCE_HOST=1 → an impossible organizationId
 *     sentinel, so every lookup misses naturally (404 semantics, no per-route
 *     branching)
 *
 * It is deliberately a WHERE BUILDER, not a find-wrapper: the ~21 call sites
 * each have their own select/include, and swapping only the `where:` property
 * keeps the sweep mechanical + reviewable. Works unchanged as a to-one
 * relation filter (`where: { id, event: await publicEventWhere(...) }`).
 *
 * Guarded by scripts/check-tenant-scoping.sh — new public event lookups that
 * bypass this helper fail CI.
 */
import type { EventStatus, Prisma } from "@prisma/client";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";

/**
 * A cuid can never equal this, so under host enforcement every lookup built
 * here misses without any route-level 404 branching.
 */
export const UNRESOLVED_TENANT_SENTINEL = "__tenant_unresolved__";

export interface PublicEventScopeOptions {
  /** Status gate, e.g. ["PUBLISHED", "LIVE"]. Omit for no status filter. */
  statuses?: EventStatus[];
  /**
   * Legacy `OR: [{ slug }, { id: slug }]` fallback — some public URLs carry an
   * event ID where the slug belongs. Keep exactly where the legacy where had it.
   */
  allowIdFallback?: boolean;
}

/**
 * Core builder for callers that already extracted the Host header (server
 * components / `generateMetadata`, which have no Request object).
 */
export async function publicEventWhereForHost(
  host: string | null | undefined,
  slug: string,
  opts: PublicEventScopeOptions = {},
): Promise<Prisma.EventWhereInput> {
  const res = await resolveTenantOrg(normalizeHost(host));
  return {
    ...(res.source === "unknown-enforced"
      ? { organizationId: UNRESOLVED_TENANT_SENTINEL }
      : res.orgId
        ? { organizationId: res.orgId }
        : {}),
    ...(opts.allowIdFallback ? { OR: [{ slug }, { id: slug }] } : { slug }),
    ...(opts.statuses ? { status: { in: opts.statuses } } : {}),
  };
}

/** Route-handler entry point — reads the Host header off the request. */
export async function publicEventWhere(
  req: Request,
  slug: string,
  opts: PublicEventScopeOptions = {},
): Promise<Prisma.EventWhereInput> {
  return publicEventWhereForHost(req.headers.get("host"), slug, opts);
}

/**
 * Defense-in-depth check for TOKEN-based public routes (rsvp, reimbursement,
 * agreements, survey token, complete-registration): their tokens are globally
 * unique and every route already asserts the event slug, so identity is
 * correct without tenancy — but a token minted for tenant A shouldn't render
 * on tenant B's domain. Call AFTER loading the row; pass the loaded event's
 * organizationId. Under unscoped/default resolution on master this is
 * tautologically true (behavior-preserving).
 */
export async function eventMatchesRequestTenant(
  req: Request,
  organizationId: string,
): Promise<boolean> {
  const res = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
  if (res.source === "unknown-enforced") return false;
  return !res.orgId || res.orgId === organizationId;
}
