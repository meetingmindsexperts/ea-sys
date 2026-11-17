/**
 * How a query on `Event` gets its tenant lane (Event RLS, Nov 5 to 17 2026).
 *
 * WHY EVENT IS SPECIAL. Every other policied table is read inside a lane the
 * caller already has. Event is how many requests FIND their lane: a public
 * route knows a slug, a reviewer knows an event id, and neither knows the
 * organisation until the Event has been read. With a row policy on Event, a
 * read made outside a lane returns null, so the route answers 404 with nothing
 * in the logs. Every read of Event therefore goes through one of the doors in
 * this file, by who is asking:
 *
 *   - a PUBLIC address (a slug on a host): `findPublicEvent`,
 *     `resolvePublicEventOrg`, `resolvePublicEventTenant`. The host names the
 *     tenant and `publicEventWhere` puts it in the filter, so the lane is
 *     entered first, for the organisation the filter names. Nothing privileged.
 *   - a PUBLIC LIST (the catalogue, the sitemap): `inHostLane`, `inScopeLane`.
 *   - a PERMISSION GATE on one event: `findGatedEvent`. A team role or an API
 *     key reads inside its own organisation's lane. A reviewer, submitter or
 *     registrant reaches an event through their link to it, so the event's
 *     organisation is discovered first (`resolveEventTenant`, below).
 *   - a LIST behind a gate: `inOwnLane`.
 *   - a dashboard PAGE: `inSessionLane` (page-lane.ts, which needs next/headers).
 *
 * THE ONE READ MADE BEFORE A LANE EXISTS is `resolveEventTenant`: the
 * sanctioned discovery, for a caller who holds an event's id and no lane. Its
 * contract is what makes it safe: it returns ONLY the id and the organisation,
 * never event content, for a filter the caller's gate has already scoped.
 * Callers then read everything else inside `runWithTenant(organizationId)`,
 * where row security applies normally. It runs inside `asEventDiscovery`, so
 * the shadow detector (lane-shadow.ts) does not report it.
 *
 * It reads through the PRIVILEGED client (`dbOperator`, since the Event
 * policy was promoted into prisma/rls/event.sql on Nov 17, 2026): where row
 * security is on, no other client can read an event before a lane exists. On
 * master the two clients are the same object, so nothing changed there. This
 * file is on the privileged allow-list (scripts/check-tenant-als.sh) for that
 * one read and no other: never reach for `dbOperator` here to return content.
 */
import type { Prisma } from "@prisma/client";
import { db, dbOperator } from "@/lib/db";
import { publicEventWhere, publicEventWhereForHost, publicOrgScopeForHost, type PublicEventScopeOptions } from "@/lib/public-event";
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
  return asEventDiscovery(() => dbOperator.event.findFirst({ where, select: { id: true, organizationId: true } }));
}

/**
 * Run a read of Event inside the lane of the organisation its filter names.
 * `publicEventWhere` puts the host's organisation in the filter (or the
 * sentinel, for a host the deployment refused); a filter with none comes from
 * a deployment that cannot say whose address this is (a developer's machine),
 * and there the read runs as it always has.
 *
 * A string, or absent: the type also admits a filter object, which the builder
 * never emits, and if it did there would be no lane, which fails closed.
 */
function inFilterLane<T>(where: Prisma.EventWhereInput, read: () => Promise<T>): Promise<T> {
  const organizationId = typeof where.organizationId === "string" ? where.organizationId : null;
  return organizationId ? runWithTenant(organizationId, read) : read();
}

/**
 * The id and organisation of the event behind a filter `publicEventWhere`
 * built, read inside the lane that filter names. For a public caller that
 * keeps the filter (the webinar chat caches by it). Nothing privileged.
 */
export function resolvePublicEventTenant(where: Prisma.EventWhereInput): Promise<EventTenant | null> {
  return inFilterLane(where, () => db.event.findFirst({ where, select: { id: true, organizationId: true } }));
}

/**
 * The organisation behind a public URL's event slug, on this request's host.
 * Call BEFORE any token or row lookup, then run the rest of the handler inside
 * `runWithTenant(<this org>)`. Null when the slug does not resolve on this host.
 * Read inside the host's own lane since Nov 17, 2026, never through the
 * discovery above: a public address already says whose it is.
 */
export async function resolvePublicEventOrg(
  req: Request,
  slug: string,
  opts?: PublicEventScopeOptions,
): Promise<string | null> {
  const event = await resolvePublicEventTenant(await publicEventWhere(req, slug, opts));
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
 * A caller whose reach is their LINK to an event (a reviewer, a submitter, a
 * registrant), not an organisation. Only they are answered through the
 * privileged discovery. A team role or a key that carries no organisation is
 * not: it has no lane, and is not handed one by a read that sees every tenant
 * (owner, Aug 11 2026, PLATFORM_DECISIONS item 5: an operator reaching into a
 * tenant's event is answered by a membership in the tenant, never by a
 * privilege in the route).
 */
function reachesByLink(principal: EventGate["principal"]): boolean {
  return !principal.fromApiKey && !!principal.baseRole && !isTeamRole(principal.baseRole);
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
 * Run a query over SEVERAL events behind a gate (a list, a count) inside a
 * lane: the caller's own organisation's when their reach is that organisation
 * (a team role, an API key), and for anyone else the lane of the organisation
 * the request's HOST names.
 *
 * WHY THE HOST for a reviewer, submitter or registrant (Nov 17, 2026). Their
 * account's organisation does not say which events they reach, so it cannot be
 * their lane. The front door they came through can: sign-in already resolves
 * the tenant from the host, the registrant portal's routes already take their
 * lane from it (`resolveRequestOrgId`), and on the platform an account belongs
 * to one tenant (PLATFORM_DECISIONS §6), so every event a person is linked to
 * is the host's organisation's. On master the host names the one organisation.
 * Pass the request, or the Host header a server component read.
 */
export function inOwnLane<T>(gate: Pick<EventGate, "principal">, source: PublicSource, fn: () => Promise<T>): Promise<T> {
  const organizationId = ownLane(gate.principal);
  return organizationId ? runWithTenant(organizationId, fn) : inHostLane(source, fn);
}

/** A request, or the Host header a server component read from `next/headers`. */
export type PublicSource = Request | string | null | undefined;

function hostOf(source: PublicSource): string | null {
  if (source == null) return null;
  return typeof source === "string" ? source : source.headers.get("host");
}

/**
 * Run a PUBLIC read inside the lane of the organisation this request's host
 * names: a catalogue, a sitemap, any read that lists events and so has no one
 * event to discover. The filter the caller built (`publicOrgScopeForHost`,
 * `publicEventWhere`) already names that organisation; the lane makes the
 * database hold it to that as well.
 *
 * With no organisation from the host there are two cases. An enforcing
 * deployment refused the host: the scope is the sentinel id, and its lane
 * answers nothing, as the sentinel filter does. A deployment that does not
 * enforce hosts and has no default organisation (a developer's machine) has
 * no lane to give: the read runs as it always has.
 */
export async function inHostLane<T>(source: PublicSource, fn: () => Promise<T>): Promise<T> {
  return inScopeLane(await publicOrgScopeForHost(hostOf(source)), fn);
}

/**
 * The same, for a caller that has already turned the host into an organisation
 * scope (`publicOrgScopeForHost`): the catalogue's loaders are handed the
 * scope, not the request. A refused host's scope is the sentinel id, and a
 * lane for an organisation that does not exist answers nothing.
 */
export function inScopeLane<T>(scope: { organizationId?: string }, fn: () => Promise<T>): Promise<T> {
  return scope.organizationId ? runWithTenant(scope.organizationId, fn) : fn();
}

/**
 * The event behind a PUBLIC address, read the way that survives an Event
 * policy (Event RLS step 2, third sweep, Nov 17 2026). It is
 * `db.event.findFirst({ where: await publicEventWhere(req, slug, scope), ...args })`,
 * and on master it is that query, unchanged.
 *
 * WHY A PUBLIC ROUTE CALLS THIS. It used to make that read outside any lane
 * and only then enter `runWithTenant(event.organizationId)`: under a policy
 * the first read returns null and every public page of every event answers
 * "not found". The host already names the tenant, and `publicEventWhere` has
 * put that organisation in the filter, so the lane is entered FIRST, for the
 * organisation the filter names, and the event read inside it. Nothing
 * privileged is involved: a mistake in the filter still cannot reach another
 * tenant's event.
 *
 * Where the host names no organisation (a developer's machine, with no domain
 * row and no default) the filter carries none and there is no lane to enter:
 * the read runs as it always has. With row security on that finds nothing,
 * which is the right answer for a deployment that cannot say whose page this
 * is; the platform refuses such a host outright.
 *
 * `scope` is what `publicEventWhere` takes: the statuses, and whether an id
 * may stand where the slug belongs. Pass `{}` for neither.
 */
export async function findPublicEvent<A extends GatedEventArgs>(
  source: PublicSource,
  slug: string,
  scope: PublicEventScopeOptions,
  args: Prisma.SelectSubset<A, GatedEventArgs>,
): Promise<Prisma.EventGetPayload<A> | null> {
  const where =
    typeof source === "string" || source == null
      ? await publicEventWhereForHost(source, slug, scope)
      : await publicEventWhere(source, slug, scope);
  const read = () =>
    db.event.findFirst({ ...(args as GatedEventArgs), where }) as unknown as Promise<Prisma.EventGetPayload<A> | null>;
  return inFilterLane(where, read);
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
 *   - for a caller who reaches the event by their LINK to it (a reviewer, a
 *     submitter, a registrant): through the sanctioned discovery
 *     (`resolveEventTenant`, the only read made before a lane exists, on the
 *     privileged client). When the route asks for no more than the id and the
 *     organisation, the discovery's answer is the result. When it asks for
 *     more, the event is found first and then read inside ITS organisation's
 *     lane, so event content never comes back from a read outside a lane.
 *   - for a team role or a key that carries no organisation: in the empty
 *     lane. On master that is the query as it always ran; where row security
 *     is on it finds nothing, and the privileged read is never used for it.
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
  // A team role or a key with no organisation: the empty lane, which is a
  // pass-through on master and answers nothing where row security is on. The
  // route's own `runWithTenantLane` logs `tenant:no-org-lane` for it.
  if (!reachesByLink(gate.principal)) return runWithTenant("", () => read(gate.eventWhere));
  // ONE read is made before a lane exists, and it is `resolveEventTenant`
  // (review of 2db57e7f), on the privileged client. A second pre-lane read
  // written here would answer 404 to every reviewer, submitter and registrant.
  const tenant = await resolveEventTenant(gate.eventWhere);
  if (!tenant) return null;
  if (asksOnlyDiscoveryColumns(args as GatedEventArgs)) return onlyAsked(tenant, args as GatedEventArgs) as Prisma.EventGetPayload<A>;
  return runWithTenant(tenant.organizationId, () => read({ AND: [gate.eventWhere, { id: tenant.id }] }));
}
