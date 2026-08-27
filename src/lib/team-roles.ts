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
