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
import { runWithTenant } from "@/lib/tenant-context";
import { isTeamRole } from "@/lib/team-roles";

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

/** What a permission gate hands a route: who is asking, and which events they may reach. */
export interface EventGate {
  principal: { organizationId: string | null; baseRole: string | null; fromApiKey: boolean };
  eventWhere: Prisma.EventWhereInput;
}

/**
 * The lane a caller can be put in BEFORE the event is known: their own
 * organisation's, and only when their reach IS that organisation (a team role,
 * or an organisation's API key). A reviewer, submitter or registrant reaches an
 * event through their link to it, whatever organisation their account carries
 * (the internal-domain rule attaches one), so the event may belong to another
 * organisation: for them the event's organisation is discovered.
 */
function ownLane(principal: EventGate["principal"]): string | null {
  if (!principal.organizationId) return null;
  return principal.fromApiKey || isTeamRole(principal.baseRole) ? principal.organizationId : null;
}

/**
 * What a route may say about the row it wants: its shape, nothing about WHICH
 * row. The gate's filter picks the row; an ordering or an offset here would be
 * ignored by the discovery read and could then pick a different one.
 */
type GatedEventArgs = Pick<Prisma.EventFindFirstArgs, "select" | "include" | "omit">;

/**
 * A gate for a caller that is not a signed-in person but is already bound to
 * ONE organisation: the AI agent's tools and services, which hold the
 * organisation's id and build their own organisation-scoped filter. Read as an
 * organisation's API key is: inside that organisation's lane.
 */
export function organisationGate(organizationId: string, eventWhere: Prisma.EventWhereInput): EventGate {
  return { principal: { organizationId, baseRole: null, fromApiKey: true }, eventWhere };
}

/**
 * Run a query over SEVERAL events behind a gate (a list, a count) inside the
 * caller's own lane, when their reach is their organisation: a team role or
 * an API key. For anyone else it runs as it is: a reviewer's, submitter's or
 * registrant's list can span organisations, which one lane cannot hold. That
 * list still reads outside a lane and is the open item in
 * docs/SECURITY_AUDIT_ACTION_PLAN.md §3.1.
 */
export function inOwnLane<T>(gate: EventGate, fn: () => Promise<T>): Promise<T> {
  const organizationId = ownLane(gate.principal);
  return organizationId ? runWithTenant(organizationId, fn) : fn();
}

/** The two columns the sanctioned discovery read may return. */
const DISCOVERY_COLUMNS = new Set(["id", "organizationId"]);

function asksOnlyDiscoveryColumns(args: GatedEventArgs): boolean {
  const select = args.select;
  if (!select || args.include) return false;
  const asked = Object.entries(select).filter(([, on]) => on);
  return asked.length > 0 && asked.every(([column, on]) => on === true && DISCOVERY_COLUMNS.has(column));
}

/** The discovered event, cut down to the columns the route asked for. */
function onlyAsked(tenant: EventTenant, args: GatedEventArgs): Partial<EventTenant> {
  const select = args.select ?? {};
  return {
    ...(select.id === true ? { id: tenant.id } : {}),
    ...(select.organizationId === true ? { organizationId: tenant.organizationId } : {}),
  };
}

/**
 * The event behind a permission gate, read the way that survives an Event
 * policy (Event RLS step 2, Nov 16 2026). It is `db.event.findFirst({ where:
 * gate.eventWhere, ...args })`, and on master it IS that query, unchanged.
 *
 * WHY A ROUTE CALLS THIS AND NOT `db.event.findFirst`. A per-event route opens
 * with that read, outside any lane, and only then enters
 * `runWithTenant(event.organizationId)`. Under a policy the first read returns
 * null and the route answers 404 with nothing logged; production's shadow
 * detector listed 115 routes doing it (docs/SECURITY_AUDIT_ACTION_PLAN.md
 * §3.1). Here the read happens:
 *
 *   - for a caller whose reach is their organisation (a team role, an API
 *     key): inside that organisation's lane, entered first. The policy then
 *     applies to the read as to everything after it, so a mistake in a gate's
 *     filter still cannot reach another tenant's event.
 *   - for anyone else (a reviewer, a submitter, a registrant, an operator with
 *     no organisation): through the sanctioned discovery (`resolveEventTenant`,
 *     the only read made before a lane exists). When the route asks for no
 *     more than the id and the organisation, the discovery's answer is the
 *     result. When it asks for more,
 *     the event is found first and then read inside ITS organisation's lane,
 *     so event content never comes back from a read outside a lane.
 *
 * The route goes on to `runWithTenant(event.organizationId, ...)` exactly as
 * before. Never pass a filter here that the gate did not build.
 */
export async function findGatedEvent<A extends GatedEventArgs>(
  gate: EventGate,
  args: Prisma.SelectSubset<A, GatedEventArgs>,
): Promise<Prisma.EventGetPayload<A> | null> {
  const read = (where: Prisma.EventWhereInput) =>
    db.event.findFirst({ ...(args as GatedEventArgs), where }) as unknown as Promise<Prisma.EventGetPayload<A> | null>;

  const organizationId = ownLane(gate.principal);
  if (organizationId) return runWithTenant(organizationId, () => read(gate.eventWhere));
  // ONE read is made before a lane exists, and it is `resolveEventTenant`
  // (review of 2db57e7f): the day discovery moves to the privileged client, it
  // moves there for this function too. A second pre-lane read written here
  // would stay behind and answer 404 to every reviewer, submitter and registrant.
  const tenant = await resolveEventTenant(gate.eventWhere);
  if (!tenant) return null;
  if (asksOnlyDiscoveryColumns(args as GatedEventArgs)) return onlyAsked(tenant, args as GatedEventArgs) as Prisma.EventGetPayload<A>;
  return runWithTenant(tenant.organizationId, () => read({ AND: [gate.eventWhere, { id: tenant.id }] }));
}
