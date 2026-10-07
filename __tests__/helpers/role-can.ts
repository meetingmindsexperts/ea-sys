/**
 * The old role predicates, answered by `can()` (custom roles Phase 6, Oct 6,
 * 2026). The application code no longer has `canViewFinance`,
 * `canViewEntryBarcode` and the rest: every boundary is a permission. The
 * tests that state each boundary role by role ("MEMBER sees money, CRM_USER
 * does not") are still the clearest record of the access model, so they keep
 * their shape and ask these, which ask `can()` for a built-in role. An API
 * key is the full API key principal.
 *
 * Test-only. Never import from `src/`.
 */
import { can, principalFromUser, type Principal } from "@/lib/permissions/can";
import { principalFromApiKey } from "@/lib/permissions/require-permission";
import type { PermissionKey } from "@/lib/permissions/catalogue";

const ORG = "org-test";
const EVENT = { organizationId: ORG, eventType: "CONFERENCE", staffUserIds: ["u-test"] };

function principal(role: string | null | undefined, isApiKey = false, hrAccess = false): Principal | null {
  if (isApiKey) return principalFromApiKey(ORG);
  if (!role) return null;
  return principalFromUser({ id: "u-test", role, organizationId: ORG, hrAccess });
}

/** Does this role (or an API key) hold `key`, on an event it is assigned to where the key is event-bound? */
export function roleCan(key: PermissionKey, role: string | null | undefined, isApiKey = false, hrAccess = false): boolean {
  const p = principal(role, isApiKey, hrAccess);
  return !!p && can(p, key, { event: EVENT });
}

export const canViewFinance = (role: string | null | undefined, isApiKey = false) => roleCan("finance.view", role, isApiKey);
export const canViewEntryBarcode = (role: string | null | undefined, isApiKey = false) => roleCan("barcode.view", role, isApiKey);
export const canViewZoomHostCredentials = (role: string | null | undefined, isApiKey = false) => roleCan("zoomHost.view", role, isApiKey);
export const canExportRegistrations = (role: string | null | undefined, isApiKey = false) => roleCan("registrations.export", role, isApiKey);
export const canViewSupportingDocument = (role: string | null | undefined) => roleCan("supportingDocs.view", role);
export const canViewLoginActivity = (role: string | null | undefined) => roleCan("loginActivity.read", role);
export const canViewContacts = (role: string | null | undefined, isApiKey = false) => roleCan("contacts.read", role, isApiKey);
export const canExportContacts = (role: string | null | undefined, isApiKey = false) => roleCan("contacts.export", role, isApiKey);
export const canViewCrm = (role: string | null | undefined, isApiKey = false) => roleCan("crm.read", role, isApiKey);
export const canOwnDeals = (role: string | null | undefined, isApiKey = false) => roleCan("crm.write", role, isApiKey);
export const canViewDealValues = (role: string | null | undefined, isApiKey = false) => roleCan("crm.dealValues.view", role, isApiKey);
export const canViewCrmInbox = (role: string | null | undefined, isApiKey = false) => roleCan("crm.inbox.read", role, isApiKey);
export const canDeleteCrm = (role: string | null | undefined, isApiKey = false) => roleCan("crm.delete", role, isApiKey);
export const canExportCrm = (role: string | null | undefined, isApiKey = false) => roleCan("crm.export", role, isApiKey);
export const canPurgeCrm = (role: string | null | undefined, isApiKey = false) => roleCan("crm.purge", role, isApiKey);
export const canUseAgent = (role: string | null | undefined) => roleCan("agent.use", role);

/** HR: `hr.read` / `hr.write`, with the person's `hrAccess` tick. */
export const canViewHr = (user: { role?: string | null; hrAccess?: boolean | null } | null | undefined) =>
  roleCan("hr.read", user?.role, false, user?.hrAccess === true);
export const canWriteHr = (user: { role?: string | null; hrAccess?: boolean | null } | null | undefined) =>
  roleCan("hr.write", user?.role, false, user?.hrAccess === true);

/** The roles holding `agent.use` (was `AGENT_ROLES`). */
export const AGENT_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER"].filter((r) =>
  roleCan("agent.use", r),
);
