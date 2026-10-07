/**
 * Who is staff, in a module the browser can import.
 *
 * This lives apart from `auth-guards` for one reason: that module imports
 * `next/server` and the Pino logger, so importing it from a `"use client"`
 * component pulls server-only code into the bundle, where Next resolves it to
 * `undefined` and the failure is silent at build time and loud at click time.
 *
 * `auth-guards` re-exports both of these, so every existing
 * `from "@/lib/auth-guards"` import keeps working. There is still ONE list.
 */

/** Org team-member roles, as opposed to attendee / reviewer / submitter roles. */
export const TEAM_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "ORGANIZER",
  "MEMBER",
  "ONSITE",
  "CRM_USER",
  "WEBINARS",
  "HR_USER",
] as const;

/**
 * True when a role is an org team-member role. Fails closed: an unknown or
 * missing role is not staff.
 */
export function isTeamRole(role: string | null | undefined): boolean {
  return !!role && (TEAM_ROLES as readonly string[]).includes(role);
}

/**
 * The two base role pairs every hand-written role check in the application
 * turned out to be (CUSTOM_ROLES_PLAN Phase 0 step 9, Sep 30, 2026). Declared
 * here, in the browser-safe module, so a component and a route read the same
 * list; `auth-guards` re-exports them. Custom roles (Phase 1) replace these
 * with permissions, and every caller is then one import to change rather than
 * a string to find.
 *
 * WRITE_ROLES (the old general-write allow-list) is gone since custom roles
 * Phase 6 (Oct 6, 2026): writes ask a permission.
 */

/**
 * Who RECEIVES the organisation's event notifications (the bell) and who an
 * automated webinar email is attributed to. A list of people, not an access
 * rule: permissions decide what someone may do (custom roles Phase 6, Oct 6,
 * 2026), and this only names who is told. The three event-running roles.
 */
export const NOTIFIED_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] as const;

/** Does this role get the notification bell? */
export function receivesEventNotifications(role: string | null | undefined): boolean {
  return !!role && (NOTIFIED_ROLES as readonly string[]).includes(role);
}

/** Organisation administrators: users, API keys, integrations, org settings, infrastructure. */
export const ORG_ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"] as const;

/** True for SUPER_ADMIN and ADMIN. Fails closed on an unknown or missing role. */
export function isOrgAdmin(role: string | null | undefined): boolean {
  return !!role && (ORG_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * The temporary accounts the Settings → Onsite Staff tab creates and assigns:
 * ONSITE (assignment-gated desk staff) and WEBINARS (kept accepted there since
 * its Aug 10, 2026 widening made the assignment redundant but harmless).
 */
export const ONSITE_ACCOUNT_ROLES = ["ONSITE", "WEBINARS"] as const;

/**
 * The account an ORGANIZER may create and remove from Settings (`events.staff.
 * assign`): an ONSITE desk account and nothing else. A helper rather than an
 * inline comparison so the user routes, which `check-permission-guards.sh`
 * holds to no staff role names, can ask about the TARGET account's role.
 */
export function isOnsiteDeskAccount(role: string | null | undefined): boolean {
  return role === "ONSITE";
}

/**
 * HR_USER is only grantable where the HR module is switched on: the enum value
 * exists on every silo, but on a deployment without the module the role would
 * be a login that reaches nothing. The authoritative check for both the invite
 * and the role-change routes (the dropdown that hides it is only UX).
 */
export function isRoleGrantableHere(role: string, hrModuleEnabled: boolean): boolean {
  return role !== "HR_USER" || hrModuleEnabled;
}

