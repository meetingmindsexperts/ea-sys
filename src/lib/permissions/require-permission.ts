/**
 * `requirePermission()`: the route-boundary form of `can()` (docs/CUSTOM_ROLES_PLAN.md
 * Phase 1 slice 4). It replaces, per handler, `denyReviewer(...)`, the role
 * allow-lists, `requireOrgId` and the hand-rolled event lookup with one call
 * that answers three things together:
 *
 *  1. Who is asking (401 when nobody is).
 *  2. Do they hold the key at all (403 when not). For an organisation-wide key
 *     this is the whole answer.
 *  3. For an event-bound key, WHICH events: `eventWhere` is `eventWhereFor()`
 *     for the same key, so the route's lookup cannot drift from the grant that
 *     let it through (plan §7.2). An event outside the scope is a 404 from the
 *     lookup, exactly as `buildEventAccessWhere` gives today.
 *
 * THE RESULTING-OBJECT RULE (plan §3.2). A scope filters rows that exist; a
 * create has no row yet and an update can move a row out of scope. So a
 * create or update passes `resulting`, the facts the event will have AFTER the
 * write, and they must be admitted by a held grant of the same key. A
 * `WEBINAR`-scoped `events.create` therefore cannot create a conference, and a
 * `WEBINAR`-scoped `events.update` cannot flip a webinar into one. This is the
 * one rule that replaces the two hand-written WEBINAR_ONLY checks.
 *
 * NOTHING CALLS THIS YET. Phase 2 sweeps the routes onto it domain by domain,
 * each behind a route status matrix snapshot (`__tests__/api/route-matrix/`).
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { apiLogger } from "@/lib/logger";
import { buildEventAccessWhere } from "@/lib/event-access";
import { describePermission, type PermissionKey } from "./catalogue";
import { can, eventWhereFor, principalFromUser, systemPrincipal, type EventFacts, type Principal } from "./can";
import type { Grant } from "./system-roles";

/**
 * The principal for a signed-in person. Custom-role keys arrive resolved on
 * the session (slice 3); every live one is organisation-wide today, so they
 * carry no scope. When an event-bound key becomes live the session will need
 * the pairs, and `cleanGrants` already refuses one stored without a scope.
 */
export function principalFromSession(session: Session): Principal {
  // One builder for server and screens (custom roles Phase 3): see can.ts.
  return principalFromUser(session.user);
}

/** The principal for an organisation API key: the API_KEY system row, no person grants. */
/**
 * An API key. Without a role it is the full "API key" system role, as every
 * key was before Phase 5. With one (`grants`), it holds exactly that role's
 * grants and nothing of the system row, on REST and MCP alike (plan §8.1).
 */
export function principalFromApiKey(organizationId: string, grants?: readonly Grant[] | null): Principal {
  const full = systemPrincipal({ role: null, organizationId, fromApiKey: true });
  if (!grants) return full;
  return { ...full, grants: [...grants] };
}

/**
 * The principal for a route that takes BOTH a session and `getOrgContext()`
 * (an API key or a mobile token). The session wins when there is one: it
 * carries the person's grants, and for a signed-in person the org context
 * names the same organisation. A mobile token carries a role and no custom
 * keys; an API key is the API_KEY row.
 */
export function principalFromCaller(
  session: Session | null | undefined,
  orgCtx: { organizationId: string; userId?: string | null; role?: string | null; fromApiKey?: boolean; apiKeyGrants?: readonly Grant[] | null } | null | undefined,
): Principal | null {
  if (session?.user) return principalFromSession(session);
  if (!orgCtx) return null;
  if (orgCtx.fromApiKey) return principalFromApiKey(orgCtx.organizationId, orgCtx.apiKeyGrants);
  return systemPrincipal({ role: orgCtx.role, organizationId: orgCtx.organizationId, userId: orgCtx.userId ?? null });
}

/**
 * The outside identities (plan §1): not org staff, no role in the catalogue.
 * Their access comes from being linked to an event (a reviewer pool, a speaker
 * record, a registration), which `buildEventAccessWhere` already expresses.
 */
const LINKED_EVENT_ROLES = ["REVIEWER", "SUBMITTER", "REGISTRANT"] as const;
export type LinkedRole = (typeof LINKED_EVENT_ROLES)[number];

export type PermissionGate =
  | {
      ok: true;
      principal: Principal;
      /**
       * Always defined, so a lookup built from it can never fail open: for an
       * event-bound key the events the grant reaches, otherwise none.
       */
      eventWhere: Prisma.EventWhereInput;
    }
  | { ok: false; response: NextResponse };

export interface RequirePermissionOptions {
  /** `path:METHOD`, as `requireOrgId` and `denyReviewer` take it: every refusal names its route. */
  route: string;
  /** For an event-bound key on an event-nested route: `eventWhere` is then scoped to this id. */
  eventId?: string;
  /**
   * For a create: what the event will be (§3.2). An update runs the same rule
   * through `refuseOutOfScope` once it has read the event and the body.
   */
  resulting?: Omit<EventFacts, "organizationId">;
  /**
   * What a caller who does not hold an event-bound key gets. "forbid" (the
   * default, for writes) is a 403, as `denyReviewer` gives. "hide" (for reads)
   * passes with an event filter that matches nothing, so the route's own
   * lookup answers 404 or an empty list, as `buildEventAccessWhere` gives a
   * role with no events. Reads hide and writes refuse: that is how every
   * event route answers today, and the route matrix holds the sweep to it.
   */
  onMissing?: "forbid" | "hide";
  /**
   * The outside identities (REVIEWER, SUBMITTER, REGISTRANT) hold no role in
   * the catalogue; their access is the events they are linked to. "linked"
   * passes all three with `buildEventAccessWhere` (a read they make today); a
   * list names which of them a route serves, so a registrant is not let into a
   * route that only authors and reviewers use. A route that passes them on a
   * WRITE keeps its own ownership rule (an author edits only their own row).
   * Omitted, they are refused like any caller without the key.
   */
  linkedRoles?: "linked" | readonly LinkedRole[];
}

const NO_EVENTS: Prisma.EventWhereInput = { id: { in: [] } };
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const isPrincipal = (c: Session | Principal): c is Principal => Array.isArray((c as Principal).grants);

/**
 * The §3.2 refusal for an event that a write would leave outside the
 * caller's scope, or null when the scope admits it. A caller whose only grant
 * of the key is webinar-scoped gets the `WEBINAR_ONLY` answer the two
 * hand-written checks gave before (a client may read the code).
 */
export function refuseOutOfScope(
  principal: Principal,
  permission: PermissionKey,
  resulting: Omit<EventFacts, "organizationId">,
  ctx: { route: string; eventId?: string },
): NextResponse | null {
  const facts: EventFacts = { ...resulting, organizationId: principal.organizationId ?? "" };
  if (can(principal, permission, { event: facts })) return null;
  apiLogger.warn({
    msg: "permissions:resulting-out-of-scope",
    ...ctx,
    permission,
    role: principal.baseRole,
    userId: principal.userId,
    eventType: resulting.eventType,
  });
  const scopes = new Set(principal.grants.filter((g) => g.permission === permission).map((g) => g.scope));
  const webinarOnly = scopes.size === 1 && scopes.has("WEBINAR");
  return NextResponse.json(
    webinarOnly
      ? { error: "Your role can only manage Webinar events", code: "WEBINAR_ONLY" }
      : { error: "Your role does not allow an event of this kind.", code: "OUT_OF_SCOPE" },
    { status: 403 },
  );
}

/**
 * Decide at the route boundary. Accepts the session, or a principal already
 * built (an API-key route builds one with `principalFromApiKey`).
 */
export function requirePermission(
  caller: Session | Principal | null | undefined,
  permission: PermissionKey,
  opts: RequirePermissionOptions,
): PermissionGate {
  const { route, eventId } = opts;
  if (!caller || (!isPrincipal(caller) && !caller.user)) {
    apiLogger.warn({ msg: "permissions:unauthenticated", route, permission });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const principal = isPrincipal(caller) ? caller : principalFromSession(caller);
  const eventBound = describePermission(permission)?.eventBound === true;

  const linked: readonly string[] = opts.linkedRoles === "linked" ? LINKED_EVENT_ROLES : (opts.linkedRoles ?? []);
  if (eventBound && !isPrincipal(caller) && linked.includes(caller.user.role)) {
    return { ok: true, principal, eventWhere: buildEventAccessWhere(caller.user, eventId) };
  }

  if (!can(principal, permission)) {
    const who = { route, permission, eventId, role: principal.baseRole, fromApiKey: principal.fromApiKey, userId: principal.userId };
    if (opts.onMissing === "hide" && eventBound) {
      // Logged at warn like every refusal; the lookup's 404 follows.
      apiLogger.warn({ msg: "permissions:hidden", ...who });
      return { ok: true, principal, eventWhere: NO_EVENTS };
    }
    apiLogger.warn({ msg: "permissions:denied", ...who });
    return { ok: false, response: forbidden() };
  }

  if (opts.resulting) {
    const refused = refuseOutOfScope(principal, permission, opts.resulting, { route, eventId });
    if (refused) return { ok: false, response: refused };
  }

  return { ok: true, principal, eventWhere: eventBound ? eventWhereFor(principal, permission, eventId) : NO_EVENTS };
}
