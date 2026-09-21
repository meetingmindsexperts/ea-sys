// Who reaches the in-app Event Agent. Client-safe leaf (the sidebar reads
// it); the route handler imports the same list so the menu and the API
// cannot disagree. MEMBER is admitted read-only; the org-null roles and the
// confined staff roles (ONSITE, WEBINARS, CRM_USER, HR_USER) are excluded
// by omission.
export const AGENT_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"] as const;

export function canUseAgent(role: string | null | undefined): boolean {
  return !!role && (AGENT_ROLES as readonly string[]).includes(role);
}
