import { can, principalFromUser } from "@/lib/permissions/can";
import type { Prisma } from "@prisma/client";
import { readUserGrants } from "@/lib/permissions/permission-set-service";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@/lib/permissions/system-roles";
import { isCustomRolesEnabled } from "@/lib/module-flags";

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

/** The base roles whose built-in grants include `crm.write`. */
export function crmOwnerBaseRoles(): string[] {
  return SYSTEM_ROLE_KEYS.map((k) => SYSTEM_ROLES[k])
    .filter((r) => r.baseRole && r.grants.some((g) => g.permission === "crm.write"))
    .map((r) => r.baseRole as string);
}

/**
 * The same rule as a user filter, for resolving many owners at once (the CSV
 * import): a CRM-capable base role, or, with custom roles switched on, a live
 * custom role granting `crm.write`.
 */
export function crmOwnerUserWhere(organizationId: string): Prisma.UserWhereInput {
  const byRole: Prisma.UserWhereInput = { role: { in: crmOwnerBaseRoles() as Prisma.EnumUserRoleFilter["in"] } };
  if (!isCustomRolesEnabled()) return { organizationId, ...byRole };
  return {
    organizationId,
    OR: [
      byRole,
      { permissionSets: { some: { permissionSet: { archivedAt: null, permissions: { some: { permission: "crm.write" } } } } } },
    ],
  };
}
