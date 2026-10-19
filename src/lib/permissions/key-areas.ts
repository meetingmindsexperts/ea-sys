import { describePermission, type PermissionKey } from "./catalogue";
import { systemRoleFor, type Area, type AreaGrant, type GrantScope } from "./system-roles";

/**
 * Which part of the app a permission belongs to, and whether a custom grant
 * fits inside a person's base role (review M6, Oct 6, 2026).
 *
 * The design says a custom role ADDS keys within the areas the base role
 * already works in, plus any of the base role's `extendableAreas` (only CRM
 * User has them, Oct 19, 2026: a role may give a salesperson event work, and
 * the person then works that area through `customGrantAreas`). The sidebar and the middleware enforce
 * areas, the API does not, so without this a CRM user given "export
 * registrations" could pull them through the API while every page of theirs
 * redirected to the CRM. The rule is applied where a grant reaches a person:
 * assigning a role, editing a role somebody holds, restoring one.
 *
 * Client-safe: pure, constants only.
 */

/** The event keys of the registration desk (`desk` area); every other event key is `events`. */
const DESK_KEYS: ReadonlySet<string> = new Set([
  "events.read",
  "registrations.read",
  "registrations.create",
  "registrations.update",
  "registrations.checkin",
  "registrations.badges.print",
  "registrations.export",
  "payments.record",
  "dtcm.assign",
]);

/** The area a key belongs to. */
export function keyArea(key: string): Area {
  if (key.startsWith("crm.")) return "crm";
  if (key.startsWith("hr.")) return "hr";
  if (key.startsWith("procurement.")) return "procurement";
  if (describePermission(key as PermissionKey)?.eventBound) return DESK_KEYS.has(key) ? "desk" : "events";
  return "org";
}

/** Does an area (or grant) scope admit a grant at `scope`? ALL or none admits everything. */
function scopeCovers(outer: GrantScope | undefined | null, inner: GrantScope | null): boolean {
  if (!outer || outer === "ALL") return true;
  return inner === outer;
}

export interface AreaGrantRequest {
  permission: string;
  scope: GrantScope | null;
}

/**
 * The grants that would take a person of `baseRole` outside their areas.
 * A grant passes when the base role already holds that key at a scope that
 * covers it (some event keys sit outside a role's areas by design, such as
 * the agenda an Onsite desk reads), or when its area is one the role works in,
 * at a covering scope. An unknown role fails closed: every grant is outside.
 */
export function grantsOutsideAreas(baseRole: string | null | undefined, grants: readonly AreaGrantRequest[]): AreaGrantRequest[] {
  const role = systemRoleFor(baseRole);
  if (!role) return [...grants];
  // A custom role may also add the areas the base role lets it extend into.
  const allowed = [...role.areas, ...(role.extendableAreas ?? [])];
  return grants.filter((g) => {
    const ownGrant = role.grants.some((r) => r.permission === g.permission && scopeCovers(r.scope ?? null, g.scope));
    if (ownGrant) return false;
    const area = keyArea(g.permission);
    const inside = allowed.some((a) => a.area === area && scopeCovers(a.scope, g.scope));
    return !inside;
  });
}

/**
 * The extra areas a person works in because a custom role they hold grants a
 * key in one of their base role's `extendableAreas` (a CRM User with a Sales
 * role that adds sponsors works the events area). Only those areas, at the
 * base role's scope for them: never more than the base role allows a role to
 * add, and nothing at all for a role without extendable areas.
 */
/**
 * The organisation pages, and the keys that open each (review of 4515a5ca,
 * L4). A custom role that extends a base role into the organisation area
 * opens only the pages whose keys it grants, never all of them: one "AI
 * agent" key must not open Settings or the invoice book. Keys that open no
 * page (the field-visibility keys) open nothing. Client-safe.
 */
export const ORG_PAGE_KEYS: Readonly<Record<string, readonly string[]>> = {
  "/contacts": ["contacts.read", "contacts.write", "contacts.delete", "contacts.import", "contacts.export"],
  "/invoices": ["invoices.ledger"],
  "/media": ["media.library.manage"],
  "/activity": ["activity.org.read", "loginActivity.read"],
  "/agent": ["agent.use"],
  "/settings": [
    "org.settings", "org.credentials", "users.read", "users.invite", "users.manage", "roles.manage",
    "billingAccounts.read", "billingAccounts.manage", "apiKeys.manage",
  ],
};

/**
 * The organisation pages a held custom role opens for a base role that may be
 * extended into the organisation area: only pages whose keys the role grants
 * and the base role does not already hold.
 */
export function customOrgPages(baseRole: string | null | undefined, grants: readonly AreaGrantRequest[]): string[] {
  const role = systemRoleFor(baseRole);
  if (!role?.extendableAreas?.some((a) => a.area === "org")) return [];
  const added = grants.filter((g) => !role.grants.some((r) => r.permission === g.permission)).map((g) => g.permission);
  return Object.entries(ORG_PAGE_KEYS)
    .filter(([, keys]) => keys.some((k) => added.includes(k)))
    .map(([page]) => page);
}

export function customGrantAreas(baseRole: string | null | undefined, grants: readonly AreaGrantRequest[]): AreaGrant[] {
  const role = systemRoleFor(baseRole);
  const extendable = role?.extendableAreas ?? [];
  if (!role || extendable.length === 0) return [];
  const out: AreaGrant[] = [];
  for (const g of grants) {
    // A key the base role already holds adds nothing (a CRM User's own
    // contacts.read must not open the organisation's Settings).
    if (role.grants.some((r) => r.permission === g.permission && scopeCovers(r.scope ?? null, g.scope))) continue;
    const area = keyArea(g.permission);
    // The organisation area is never opened whole by a custom role: its pages
    // open one by one (customOrgPages).
    if (area === "org") continue;
    const allowedAs = extendable.find((a) => a.area === area && scopeCovers(a.scope, g.scope));
    if (allowedAs && !out.some((a) => a.area === area)) out.push(allowedAs);
  }
  return out;
}
