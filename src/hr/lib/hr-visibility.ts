/**
 * WHO MAY SEE HR: the predicate, with no server-only imports.
 *
 * Split out of `hr-roles.ts` so the SIDEBAR can ask the same question the route
 * guard asks. `hr-roles.ts` imports `next/server` and the pino logger, and
 * importing either into a `"use client"` component bundles them as `undefined`:
 * the build passes, the tests pass, and the thing silently misbehaves in the
 * browser. Same reason `team-roles.ts` exists apart from `auth-guards.ts`.
 *
 * Before this split the sidebar carried its own hand-written copy of the role
 * list, which is how a nav entry ends up disagreeing with the API about who is
 * allowed in. There is now one answer.
 *
 * The rationale for the SHAPE of the rule lives in `hr-roles.ts`; keep it there
 * rather than duplicating it here.
 */

/**
 * Roles that carry HR access on their own.
 *
 * SUPER_ADMIN because it is the platform owner and could grant itself the flag
 * anyway, so withholding it would be theatre. HR_USER because the role exists
 * for nothing else: confined to this module, a HR_USER without HR access could
 * reach nothing at all.
 *
 * ADMIN is deliberately absent (owner, Aug 31 2026): an admin needs the
 * per-person grant like anybody else.
 */
export const HR_SELF_SUFFICIENT_ROLES = new Set(["SUPER_ADMIN", "HR_USER"]);

/**
 * May this user see the HR module at all?
 *
 * Fails closed on an unknown role AND on an absent flag, so both ways of
 * arriving here without a decision having been made refuse: a role nobody has
 * classified, and a caller that forgot to select `hrAccess`.
 */
export function canViewHr(
  user: { role?: string | null; hrAccess?: boolean | null } | null | undefined,
): boolean {
  if (!user?.role) return false;
  if (HR_SELF_SUFFICIENT_ROLES.has(user.role)) return true;
  return user.hrAccess === true;
}

/**
 * May this user change HR data?
 *
 * Identical to read access, and that is a decision rather than an oversight:
 * the module has one operator plus whoever is granted, and a read-only HR role
 * has no described user. Kept separate so the day somebody wants an auditor who
 * can look and not touch, the call sites already ask the right question.
 */
export function canWriteHr(
  user: { role?: string | null; hrAccess?: boolean | null } | null | undefined,
): boolean {
  return canViewHr(user);
}
