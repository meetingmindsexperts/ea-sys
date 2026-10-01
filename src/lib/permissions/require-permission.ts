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
import { describePermission, isLivePermissionKey, type PermissionKey } from "./catalogue";
import { can, eventWhereFor, systemPrincipal, type EventFacts, type Principal } from "./can";
import type { Grant } from "./system-roles";

/**
 * The principal for a signed-in person. Custom-role keys arrive resolved on
 * the session (slice 3); every live one is organisation-wide today, so they
 * carry no scope. When an event-bound key becomes live the session will need
 * the pairs, and `cleanGrants` already refuses one stored without a scope.
 */
export function principalFromSession(session: Session): Principal {
  const u = session.user;
  const customGrants: Grant[] = (u.procurementPermissions ?? [])
    .filter(isLivePermissionKey)
    .map((permission) => ({ permission }));
  return systemPrincipal({
    role: u.role,
    organizationId: u.organizationId,
    userId: u.id,
    personGrants: {
      hrAccess: u.hrAccess,
      procurementRequest: u.procurementRequest,
      procurementSettle: u.procurementSettle,
      procurementApproveCeilingAed: u.procurementApproveCeilingAed,
      procurementApproveUnlimited: u.procurementApproveUnlimited,
    },
    customGrants,
  });
}

/** The principal for an organisation API key: the API_KEY system row, no person grants. */
export function principalFromApiKey(organizationId: string): Principal {
  return systemPrincipal({ role: null, organizationId, fromApiKey: true });
}

export type PermissionGate =
  | { ok: true; principal: Principal; eventWhere: Prisma.EventWhereInput | null }
  | { ok: false; response: NextResponse };

export interface RequirePermissionOptions {
  /** `path:METHOD`, as `requireOrgId` and `denyReviewer` take it: every refusal names its route. */
  route: string;
  /** For an event-bound key on an event-nested route: `eventWhere` is then scoped to this id. */
  eventId?: string;
  /**
   * For a create or update: what the event will be after the write (§3.2).
   * The organisation is the principal's own; a create cannot place an event elsewhere.
   */
  resulting?: Omit<EventFacts, "organizationId">;
}

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
  const isPrincipal = (c: Session | Principal): c is Principal => Array.isArray((c as Principal).grants);
  if (!caller || (!isPrincipal(caller) && !caller.user)) {
    apiLogger.warn({ msg: "permissions:unauthenticated", route, permission });
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const principal = isPrincipal(caller) ? caller : principalFromSession(caller);
  const who = { route, permission, eventId, role: principal.baseRole, fromApiKey: principal.fromApiKey, userId: principal.userId };

  if (!can(principal, permission)) {
    apiLogger.warn({ msg: "permissions:denied", ...who });
    return { ok: false, response: forbidden() };
  }

  if (opts.resulting) {
    const facts: EventFacts = { ...opts.resulting, organizationId: principal.organizationId ?? "" };
    if (!can(principal, permission, { event: facts })) {
      apiLogger.warn({ msg: "permissions:resulting-out-of-scope", ...who, eventType: opts.resulting.eventType });
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Your role does not allow an event of this kind.", code: "OUT_OF_SCOPE" },
          { status: 403 },
        ),
      };
    }
  }

  const eventWhere = describePermission(permission)?.eventBound ? eventWhereFor(principal, permission, eventId) : null;
  return { ok: true, principal, eventWhere };
}
