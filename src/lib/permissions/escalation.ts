import { can, type Principal } from "./can";
import { describePermission, type PermissionKey } from "./catalogue";
import type { GrantScope } from "./system-roles";

/**
 * The editor's anti-escalation rules (custom roles plan §7.4). Pure, so they
 * are pinned exhaustively by test and the service only asks them.
 *
 *  - You can grant only what you hold, at a scope no wider than your own.
 *  - `roles.manage`, `users.manage` and `org.credentials` together are the
 *    keys that make more admins; any of them is grantable only by a person
 *    who holds all three, so a role administrator cannot mint a user admin.
 */

export const ADMIN_TRIO: readonly PermissionKey[] = ["roles.manage", "users.manage", "org.credentials"];

export interface GrantRequest {
  permission: PermissionKey;
  scope: GrantScope | null;
}

/**
 * Does the actor's access include this grant, at this scope or wider? Judged
 * on the grants the actor's roles hold, not on whether they can act on it
 * this minute: a key that also needs a person grant (approving spend) is
 * still theirs to hand out, which is what lets a super admin, who by rule is
 * never an approver, build an approver role.
 */
export function actorCovers(actor: Principal, grant: GrantRequest): boolean {
  const descriptor = describePermission(grant.permission);
  if (!descriptor || !actor.organizationId) return false;
  const held = actor.grants.filter((g) => g.permission === grant.permission);
  if (!descriptor.eventBound) return held.length > 0;
  // ALL covers every scope; a narrower scope covers only itself.
  return held.some((g) => g.scope === "ALL" || g.scope === grant.scope);
}

/** Holds all three admin keys: the organisation's top administrator (SUPER_ADMIN). */
export function holdsAdminTrio(actor: Principal): boolean {
  return ADMIN_TRIO.every((key) => can(actor, key));
}

/**
 * The first grant the actor could not hand out, or null when every one is
 * covered. The top administrator may grant any key: the six procurement keys
 * a super admin's own role leaves out (they come from a person's grants, and
 * a super admin is never an approver) are still theirs to put in a role, as
 * they have been since Sep 16, 2026.
 */
export function firstGrantBeyondActor(actor: Principal, grants: readonly GrantRequest[]): GrantRequest | null {
  if (holdsAdminTrio(actor)) return null;
  return grants.find((g) => !actorCovers(actor, g)) ?? null;
}

/** True when the grants include an admin-trio key and the actor lacks one of the three. */
export function breaksAdminTrio(actor: Principal, grants: readonly GrantRequest[]): boolean {
  if (!grants.some((g) => ADMIN_TRIO.includes(g.permission))) return false;
  return !holdsAdminTrio(actor);
}
