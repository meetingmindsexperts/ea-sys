import { canEverywhere, principalFromUser, type Principal } from "./can";

/**
 * "Organisation staff" on the PUBLIC event pages (custom roles Phase 6, Oct 6,
 * 2026): the people who may open a webinar session, a recording or a draft
 * registration page without a registration, to test it. It was `canWrite`
 * (SUPER_ADMIN, ADMIN, ORGANIZER); it is now whoever may edit EVERY event of
 * the organisation, which is that same set for the built-in roles and lets a
 * custom role that grants it act the same way. A webinar-only editor (the
 * WEBINARS role) is not organisation staff here; the routes that admit it as a
 * Zoom host say so separately.
 *
 * Client-safe.
 */
export function isEventOrgStaff(
  who: Principal | { id?: string | null; role?: string | null; organizationId?: string | null; procurementPermissions?: readonly string[] | null } | null | undefined,
  eventOrganizationId: string,
): boolean {
  if (!who) return false;
  const principal = "grants" in who ? who : principalFromUser(who);
  return principal.organizationId === eventOrganizationId && canEverywhere(principal, "events.update");
}
