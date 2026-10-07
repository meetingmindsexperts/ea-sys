/**
 * Account types: which roles are staff, which an admin may assign, and who
 * administers the organisation. Not access rules.
 *
 * Until custom roles Phase 6 (Oct 6, 2026) this file also held the role-based
 * route guards (`denyReviewer`, `denyFinance`, `denyNonOrgAdmin`) and their
 * allow-lists (`WRITE_ROLES`, `REGISTRATION_DESK_ALLOW`,
 * `WEBINAR_STAFF_ALLOW`). Every route now asks `requirePermission()` instead
 * (src/lib/permissions/), and what each built-in role may do is frozen in
 * `__tests__/lib/permissions/system-role-grants-snapshot.test.ts`.
 */
import type { RETIRED_ROLES, TEAM_ROLES } from "@/lib/team-roles";

/**
 * Org-bound "team member" roles — the ones shown under Settings → Users and
 * assignable via invite. REGISTRANT/SUBMITTER/REVIEWER are org-relationship
 * roles (an internal registrant can be org-bound but is NOT a team member),
 * so they're excluded.
 *
 * DECLARED in `team-roles.ts` and re-exported here. That module has no server
 * imports, so a client component can ask "is this person staff?" without
 * dragging `next/server` and the logger into the browser bundle. Import from
 * either place; there is one list.
 */
export { TEAM_ROLES, isTeamRole } from "@/lib/team-roles";

/**
 * Roles an org admin may ASSIGN — when inviting a new team member, and when
 * changing an existing member's role. Both doors derive from this list.
 *
 * They previously kept SEPARATE hand-written lists, and the change-role door
 * silently fell four roles behind: inviting someone AS Webinars worked, while
 * moving an existing person TO Webinars failed validation. The type check
 * below makes that impossible to repeat — adding a role to TEAM_ROLES without
 * making it assignable fails the build.
 *
 * SUPER_ADMIN is deliberately EXCLUDED: it must never be grantable through an
 * ordinary admin surface. REVIEWER is included despite not being a team role —
 * reviewers are org-independent, but are invited and promoted through this
 * same door (see the Reviewers page).
 */
export const ASSIGNABLE_USER_ROLES = [
  "ADMIN",
  "ORGANIZER",
  "MEMBER",
  "ONSITE",
  "CRM_USER",
  "HR_USER",
  "REVIEWER",
] as const;

export type AssignableUserRole = (typeof ASSIGNABLE_USER_ROLES)[number];

// Compile-time guard: every team role except SUPER_ADMIN and the retired ones
// (RETIRED_ROLES, team-roles.ts) must be assignable.
// A new role added to TEAM_ROLES and forgotten here breaks the build rather
// than silently becoming un-assignable from the change-role dialog.
type _AssignableCoversTeamRoles =
  Exclude<(typeof TEAM_ROLES)[number], "SUPER_ADMIN" | (typeof RETIRED_ROLES)[number]> extends AssignableUserRole
    ? true
    : { error: "ASSIGNABLE_USER_ROLES is missing a team role" };
const _assignableCoversTeamRoles: _AssignableCoversTeamRoles = true;
void _assignableCoversTeamRoles;

export { ORG_ADMIN_ROLES, isOrgAdmin } from "@/lib/team-roles";
