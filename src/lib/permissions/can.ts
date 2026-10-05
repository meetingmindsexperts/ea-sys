/**
 * `can()`: the one question every guard will ask once the route sweep is done
 * (docs/CUSTOM_ROLES_PLAN.md Phase 1, Sep 30 2026), and `eventWhereFor()`,
 * the rows that answer goes with.
 *
 * A PRINCIPAL is a resolved caller: the union of the grants of every role they
 * hold (system role from code, custom roles from the database, the legacy
 * procurement columns as long as they exist) plus the grants on the person.
 * `can()` decides on the WHOLE (permission, scope) pair (plan §7.3): a person
 * holding `sessions.write @ WEBINAR` and `registrations.checkin @ ALL` has
 * full control on webinars and the desk on conferences, which is what holding
 * both should mean, and never the recombination of one role's scope with
 * another's power.
 *
 * `eventWhereFor()` exists so the scope can never be separated from the
 * permission (plan §7.2): a route that asks `can()` and then hand-rolls an
 * org-wide event lookup would let an ASSIGNED grant reach every event.
 *
 * NOTHING IN PRODUCTION CALLS THIS YET. `system-roles-parity.test.ts` proves
 * it agrees with every predicate the routes use today; Phase 2 moves the
 * routes onto it one domain at a time.
 *
 * Pure: no database, no HTTP. Client-safe apart from the Prisma type import.
 */
import type { Prisma } from "@prisma/client";
import { describePermission, type PermissionKey, type PersonGrant } from "./catalogue";
import { decodeSessionGrant, isPermissionKey } from "./catalogue";
import { assignedToEventWhere } from "@/lib/event-staff-where";
import { LEGACY_PROCUREMENT_GRANTS, systemRoleFor, type Area, type AreaGrant, type Grant, type GrantScope } from "./system-roles";

/** The grants that live on the PERSON (plan §3.4), as the `User` row carries them. */
export interface PersonGrants {
  hrAccess?: boolean | null;
  procurementRequest?: boolean | null;
  procurementSettle?: boolean | null;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean | null;
}

export interface Principal {
  userId: string | null;
  organizationId: string | null;
  /** The `UserRole` value; null for an API key. */
  baseRole: string | null;
  fromApiKey: boolean;
  /** The union, whole pairs. */
  grants: readonly Grant[];
  /** Effective: the person's own, plus what the base role implies. */
  personGrants: PersonGrants;
  /** The parts of the app the base role works in (`Area`, system-roles.ts). */
  areas: readonly AreaGrant[];
}

/** What `can()` needs to know about an event to judge a scope. */
export interface EventFacts {
  organizationId: string;
  eventType: string;
  /** Assigned staff: `EventStaffAssignment` rows plus `settings.onsiteUserIds` (Phase 4 transition). */
  staffUserIds?: readonly string[] | null;
}

/**
 * A principal from a base role (or an API key), the person's grants, and any
 * custom-role grants the caller has already read. The legacy procurement
 * columns become grants here (system-roles.ts, the transition arm).
 */
export function systemPrincipal(input: {
  role: string | null | undefined;
  organizationId: string | null | undefined;
  userId?: string | null;
  fromApiKey?: boolean;
  personGrants?: PersonGrants | null;
  customGrants?: readonly Grant[];
}): Principal {
  const fromApiKey = input.fromApiKey === true;
  const system = systemRoleFor(input.role, fromApiKey);
  const person = input.personGrants ?? {};
  const grants: Grant[] = [...(system?.grants ?? []), ...(input.customGrants ?? [])];

  if (!fromApiKey) {
    if (person.procurementRequest === true) grants.push(...LEGACY_PROCUREMENT_GRANTS.request);
    if (person.procurementSettle === true) grants.push(...LEGACY_PROCUREMENT_GRANTS.settle);
    if (person.procurementApproveUnlimited === true) grants.push(...LEGACY_PROCUREMENT_GRANTS.approveUnlimited);
    else if (typeof person.procurementApproveCeilingAed === "number" && person.procurementApproveCeilingAed > 0) {
      grants.push(...LEGACY_PROCUREMENT_GRANTS.approveCeiling);
    }
  }

  const implied = new Set<PersonGrant>(system?.impliedPersonGrants ?? []);
  return {
    userId: input.userId ?? null,
    organizationId: input.organizationId ?? null,
    baseRole: fromApiKey ? null : (input.role ?? null),
    fromApiKey,
    grants,
    personGrants: {
      ...person,
      hrAccess: implied.has("hrAccess") || person.hrAccess === true,
    },
    areas: system?.areas ?? [],
  };
}

/**
 * The principal for a signed-in person as their session carries them: base
 * role, organisation, the person grants and the live keys of their custom
 * roles. CLIENT-SAFE (no Node imports): the screens build the same principal
 * the routes do. `principalFromSession` on the server calls this.
 */
export function principalFromUser(u: {
  id?: string | null;
  role?: string | null;
  organizationId?: string | null;
  hrAccess?: boolean | null;
  procurementRequest?: boolean | null;
  procurementSettle?: boolean | null;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean | null;
  procurementPermissions?: readonly string[] | null;
}): Principal {
  return systemPrincipal({
    role: u.role,
    organizationId: u.organizationId,
    userId: u.id ?? null,
    personGrants: {
      hrAccess: u.hrAccess === true,
      procurementRequest: u.procurementRequest === true,
      procurementSettle: u.procurementSettle === true,
      procurementApproveCeilingAed: u.procurementApproveCeilingAed ?? null,
      procurementApproveUnlimited: u.procurementApproveUnlimited === true,
    },
    // The session's custom grants, `key` or `key@SCOPE`; the server already
    // kept only what the flag makes grantable (session-permissions.ts).
    customGrants: (u.procurementPermissions ?? [])
      .map(decodeSessionGrant)
      .filter((g): g is { permission: PermissionKey; scope?: GrantScope } => isPermissionKey(g.permission)),
  });
}

/**
 * Does this principal WORK IN `area`, for this event if the area is scoped?
 * Without an event the answer is "somewhere". A scope admits the event the
 * same way a grant's does.
 */
export function inArea(p: Principal, area: Area, event?: EventFacts | null): boolean {
  const held = p.areas.filter((a) => a.area === area);
  if (held.length === 0) return false;
  if (event === undefined) return true;
  if (!event) return false;
  return held.some((a) => a.scope === undefined || scopeAdmits(a.scope, p, event));
}

/** The platform operator: a SUPER_ADMIN with no organisation (plan §4, "not in the catalogue"). */
export function isOperator(p: Principal): boolean {
  return p.baseRole === "SUPER_ADMIN" && !p.organizationId && !p.fromApiKey;
}

function holdsPersonGrant(p: Principal, need: PersonGrant): boolean {
  if (need === "hrAccess") return p.personGrants.hrAccess === true;
  // procurementApprove: a ceiling above zero, or unlimited. The AMOUNT is judged
  // at decision time by `canApproveProcurement`; this is "may decide at all".
  const g = p.personGrants;
  return g.procurementApproveUnlimited === true || (typeof g.procurementApproveCeilingAed === "number" && g.procurementApproveCeilingAed > 0);
}

function scopeAdmits(scope: GrantScope | undefined, p: Principal, event: EventFacts): boolean {
  if (scope === "ALL") return true;
  if (scope === "WEBINAR") return event.eventType === "WEBINAR";
  if (scope === "ASSIGNED") return !!p.userId && (event.staffUserIds ?? []).includes(p.userId);
  // An event-bound key granted without a scope grants nothing: fail closed.
  return false;
}

/**
 * May this principal do `permission`? For an event-bound key, pass the event
 * to judge the scope. With no `ctx` at all the answer is "holds it somewhere",
 * which is what a menu needs and a route must never settle for (use
 * `eventWhereFor`); with a `ctx` whose event is missing the answer is no.
 */
export function can(p: Principal, permission: PermissionKey, ctx?: { event?: EventFacts | null }): boolean {
  const descriptor = describePermission(permission);
  if (!descriptor) return false;
  if (descriptor.personGrant && !holdsPersonGrant(p, descriptor.personGrant)) return false;

  if (!descriptor.eventBound) {
    // An organisation-wide key needs an organisation: every such route refuses
    // a no-org caller (`requireOrgId`), the operator included until it names a
    // tenant to act in.
    if (!p.organizationId) return false;
    return p.grants.some((g) => g.permission === permission);
  }

  // An event-bound grant without a scope grants nothing, with or without an
  // event, so a menu and `eventWhereFor` agree.
  const held = p.grants.filter((g) => g.permission === permission && g.scope !== undefined);
  if (held.length === 0) return false;
  if (ctx === undefined) return true;
  // A caller that asked about an event and had none (a lookup that missed)
  // gets no, not "holds it somewhere".
  const event = ctx.event;
  if (!event) return false;
  if (!isOperator(p) && event.organizationId !== p.organizationId) return false;
  return held.some((g) => scopeAdmits(g.scope, p, event));
}

/** Every event this principal holds `permission` on, as the `where` a route's event lookup must use. */
export function eventWhereFor(p: Principal, permission: PermissionKey, eventId?: string): Prisma.EventWhereInput {
  const none: Prisma.EventWhereInput = { id: { in: [] } };
  const descriptor = describePermission(permission);
  if (!descriptor?.eventBound) return none;
  if (descriptor.personGrant && !holdsPersonGrant(p, descriptor.personGrant)) return none;
  const scopes = new Set(p.grants.filter((g) => g.permission === permission).map((g) => g.scope));
  if (scopes.size === 0) return none;

  const byId = eventId ? { id: eventId } : {};
  if (isOperator(p)) return { ...byId };
  if (!p.organizationId) return none;
  const inOrg = { ...byId, organizationId: p.organizationId };

  if (scopes.has("ALL")) return inOrg;
  const arms: Prisma.EventWhereInput[] = [];
  if (scopes.has("WEBINAR")) arms.push({ eventType: "WEBINAR" });
  // The assignment, from the table or the JSON it replaces (Phase 4 transition).
  if (scopes.has("ASSIGNED") && p.userId) arms.push(assignedToEventWhere(p.userId));
  if (arms.length === 0) return none;
  if (arms.length === 1) return { ...inOrg, ...arms[0] };
  return { ...inOrg, OR: arms };
}
