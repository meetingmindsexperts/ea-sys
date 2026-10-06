import { can, principalFromUser } from "@/lib/permissions/can";
import { readUserGrants } from "@/lib/permissions/permission-set-service";

/**
 * May this person own CRM records (a deal, a contact, a task)? The ASSIGNEE
 * check, not the caller's: a record handed to someone outside the CRM would
 * mail them deal prose every CRM gate withholds (review R2-M5).
 *
 * Since custom roles Phase 6 (Oct 6, 2026) this is `crm.write`, from the base
 * role or from a custom role the person holds; it was `canOwnDeals(role)`,
 * the same base roles (SUPER_ADMIN, ADMIN, ORGANIZER, CRM_USER).
 */
export async function mayOwnCrmRecords(organizationId: string, user: { id: string; role: string }): Promise<boolean> {
  if (can(principalFromUser({ id: user.id, role: user.role, organizationId }), "crm.write")) return true;
  const grants = await readUserGrants(organizationId, user.id);
  return grants.some((g) => g.permission === "crm.write");
}
