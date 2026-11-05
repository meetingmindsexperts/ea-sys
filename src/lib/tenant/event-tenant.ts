/**
 * Event tenant discovery: the ONE sanctioned read of `Event` made before a
 * tenant lane exists (Event RLS preparation, step 1, Nov 5 2026).
 *
 * WHY EVENT IS SPECIAL. Every other policied table is read inside a lane. Event
 * is how many requests FIND their lane: a public route knows a slug, a token
 * route knows a slug, and neither knows the organisation until it has read the
 * Event. That is the same job `TenantDomain` does for a host, and it is why
 * Event carries no policy yet (`DELIBERATELY_UNPOLICIED` in
 * __tests__/lib/rls-coverage.test.ts). Switch a policy on while those reads
 * run outside a lane and every one of them returns null, so the route answers
 * 404 with nothing in the logs.
 *
 * WHAT THIS FILE IS FOR. Until now each surface carried its own copy of the
 * discovery read (reimbursement, travel grant, speaker profile form, RSVP: four
 * byte-identical functions). Putting it in one place means the day the Event
 * policy is promoted, discovery is ONE line to move onto the privileged lane
 * (`dbOperator`, which already sees every row and is import-gated by
 * scripts/check-tenant-als.sh) instead of a hunt across the tree.
 *
 * WHY `db` AND NOT `dbOperator` TODAY. Event has no policy yet, so `db` reads
 * it fine on every deployment, and on master the two are the same object
 * anyway. Moving to `dbOperator` now would widen the privileged allow-list
 * before anything needed it. Make that switch in the same change that
 * promotes tests/tenancy/policies/10-event-rls.sql into prisma/rls/.
 *
 * THE CONTRACT that makes the privileged read safe later: it returns ONLY the
 * id and the organisation, never event content, and the public variant builds
 * its filter through `publicEventWhere`, which already binds the request
 * host's tenant. Callers then enter `runWithTenant(organizationId)` and read
 * everything else inside the lane, where RLS applies normally.
 *
 * The read runs inside `asEventDiscovery`, so the shadow detector
 * (src/lib/tenant/lane-shadow.ts) treats it as sanctioned and does not report it.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publicEventWhere, type PublicEventScopeOptions } from "@/lib/public-event";
import { asEventDiscovery } from "@/lib/tenant/lane-shadow";

export interface EventTenant {
  id: string;
  organizationId: string;
}

/**
 * The event's id and organisation for a filter the caller has already scoped
 * (a public host-bound where, or a permission gate's event where). Null when
 * nothing matches; the caller answers 404.
 */
export async function resolveEventTenant(where: Prisma.EventWhereInput): Promise<EventTenant | null> {
  return asEventDiscovery(() => db.event.findFirst({ where, select: { id: true, organizationId: true } }));
}

/**
 * The organisation behind a public URL's event slug, on this request's host.
 * Call BEFORE any token or row lookup, then run the rest of the handler inside
 * `runWithTenant(<this org>)`. Null when the slug does not resolve on this host.
 */
export async function resolvePublicEventOrg(
  req: Request,
  slug: string,
  opts?: PublicEventScopeOptions,
): Promise<string | null> {
  const event = await resolveEventTenant(await publicEventWhere(req, slug, opts));
  return event?.organizationId ?? null;
}
