/**
 * Custom roles: reading them, and seeding the starter set once per organisation.
 *
 * SERVER-ONLY. It sits beside the client-safe `catalogue.ts` on purpose — the
 * catalogue is imported by the role editor and the sidebar, this file is not.
 * Keep the split: one `db` import in the catalogue would pull Prisma into the
 * browser bundle, where it resolves to undefined and fails at click time rather
 * than at build time.
 *
 * Runs inside the CALLER'S tenant lane and never opens one itself, the rule
 * `ensureBudgetCategories` established. Under RLS a read outside a lane returns
 * zero rows, which here reads as "this organisation has no roles" and would
 * re-seed on every call, so the lane is load-bearing rather than hygiene.
 */
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { STARTER_ROLES, isPermissionKey, type PermissionKey } from "./catalogue";

export const PERMISSION_SET_SELECT = {
  id: true,
  name: true,
  description: true,
  version: true,
  archivedAt: true,
  permissions: { select: { permission: true } },
} as const;

export interface PermissionSetView {
  id: string;
  name: string;
  description: string | null;
  version: number;
  archivedAt: Date | null;
  permissions: { permission: string }[];
}

async function readAll(organizationId: string): Promise<PermissionSetView[]> {
  return db.permissionSet.findMany({
    where: { organizationId },
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    select: PERMISSION_SET_SELECT,
  });
}

/**
 * Seeds the four starter roles ONCE per organisation (D11, narrowed by D14).
 *
 * "Once" means: an organisation holding ANY role is never re-seeded, archived
 * ones included. Archiving all four is a decision, and re-creating them behind
 * the admin's back would quietly undo it. Same rule as budget categories and
 * CRM pipeline stages.
 *
 * ALL FOUR OR NONE. The creates share one transaction because a role that
 * exists with no ticks grants nothing while looking like a role: the next call
 * would see rows and skip the seed, leaving the organisation permanently short
 * of whichever roles came after the failure.
 *
 * Idempotent under concurrency via `@@unique([organizationId, name])`: the
 * loser of a race fails, changes nothing, and re-reads the winner's rows.
 */
export async function ensureStarterPermissionSets(organizationId: string): Promise<PermissionSetView[]> {
  const existing = await readAll(organizationId);
  if (existing.length > 0) return existing;

  try {
    await tenantTransaction(async (tx) => {
      for (const role of STARTER_ROLES) {
        await tx.permissionSet.create({
          data: {
            organizationId,
            name: role.name,
            description: role.description,
            permissions: {
              // The child carries its own organizationId: a nested create does
              // not inherit it, and the RLS policy is flat on that column.
              create: role.permissions.map((permission) => ({ organizationId, permission })),
            },
          },
        });
      }
    });
    apiLogger.info({
      msg: "permissions:starter-roles-seeded",
      organizationId,
      count: STARTER_ROLES.length,
    });
  } catch (err) {
    // The expected loss is a concurrent seeder taking the unique name. Anything
    // else is worth the same line: the re-read below is the answer either way,
    // and returning an empty list would read as "no roles exist".
    apiLogger.warn({ msg: "permissions:starter-roles-seed-raced", organizationId, err });
  }

  return readAll(organizationId);
}

/**
 * The permission keys a person holds, as the UNION of their roles (D2).
 *
 * Archived roles grant nothing: archiving is how access is withdrawn from
 * everyone holding a role at once, so it has to bite here rather than only in
 * the picker.
 *
 * Keys this build does not enforce are DROPPED, not returned. A row can outlive
 * the capability it names (a permission removed from the catalogue in a later
 * deploy), and passing it through would let a stale string satisfy a future
 * check that happens to reuse the name.
 */
export async function readUserPermissions(
  organizationId: string,
  userId: string,
): Promise<PermissionKey[]> {
  const held = await db.userPermissionSet.findMany({
    where: { organizationId, userId, permissionSet: { archivedAt: null } },
    select: { permissionSet: { select: { permissions: { select: { permission: true } } } } },
  });
  const keys = new Set<PermissionKey>();
  for (const row of held) {
    for (const { permission } of row.permissionSet.permissions) {
      if (isPermissionKey(permission)) keys.add(permission);
    }
  }
  return [...keys];
}
