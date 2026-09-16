/**
 * Custom roles under RLS (docs/PROCUREMENT_ROLES_PLAN.md §5), proved through
 * the same path production would use: the ALS store, the SET LOCAL extension
 * and pgbouncer, connected as the non-owner app_user.
 *
 * WHY THIS TABLE FAMILY DESERVES ITS OWN SUITE. These three rows are the answer
 * to "who may approve money", so a cross-tenant read is not a privacy problem
 * but an authorisation one: a leaked row does not merely show a name, it is the
 * grant itself. They are also read on the AUTHENTICATION path, where a
 * fail-closed read returns zero rows and reads as "this person holds no custom
 * role" rather than as an error, which is the safe direction but only if the
 * lane is actually established.
 *
 * Domain-specific proofs:
 *   - `PermissionSet.name` is unique per ORG, not globally, so BOTH orgs hold a
 *     role called "PO Author" and the unscoped read must resolve to the
 *     caller's own row by IDENTITY, not by count (a count of 1 also passes if
 *     the two lanes are swapped).
 *   - Both children carry their own flat organizationId, so a cross-tenant read
 *     addressed by the PARENT id misses rather than resolving through a join.
 *   - Writes both ways: WITH CHECK refuses a foreign org on a create, and
 *     refuses re-homing a row the lane legitimately owns.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, UPLOADER_A_ID, UPLOADER_B_ID } from "./constants";

const PSET_A = "tenancy-pset-a";
const PSET_B = "tenancy-pset-b";
const GRANT_A = "tenancy-psetgrant-a";
const GRANT_B = "tenancy-psetgrant-b";
const HOLD_A = "tenancy-userpset-a";
const HOLD_B = "tenancy-userpset-b";

/** Both orgs seed a role under this name: `@@unique([organizationId, name])` lets them coexist. */
const SHARED_ROLE_NAME = "PO Author";
/** And both tick the same capability, so the grant child cannot be told apart by value either. */
const SHARED_PERMISSION = "procurement.budgets.create";

let owner: PrismaClient;

async function cleanup() {
  // Children first. The cascade would cover it, but an explicit order keeps a
  // partial seed from a previous failed run from wedging the next one.
  await owner.userPermissionSet.deleteMany({ where: { id: { in: [HOLD_A, HOLD_B] } } });
  await owner.permissionSetGrant.deleteMany({ where: { id: { in: [GRANT_A, GRANT_B] } } });
  await owner.permissionSet.deleteMany({ where: { id: { in: [PSET_A, PSET_B] } } });
}

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });
  await cleanup();

  await owner.permissionSet.createMany({
    data: [
      { id: PSET_A, organizationId: ORG_A_ID, name: SHARED_ROLE_NAME, description: "A's copy" },
      { id: PSET_B, organizationId: ORG_B_ID, name: SHARED_ROLE_NAME, description: "B's copy" },
    ],
  });
  await owner.permissionSetGrant.createMany({
    data: [
      { id: GRANT_A, organizationId: ORG_A_ID, permissionSetId: PSET_A, permission: SHARED_PERMISSION },
      { id: GRANT_B, organizationId: ORG_B_ID, permissionSetId: PSET_B, permission: SHARED_PERMISSION },
    ],
  });
  await owner.userPermissionSet.createMany({
    data: [
      { id: HOLD_A, organizationId: ORG_A_ID, userId: UPLOADER_A_ID, permissionSetId: PSET_A },
      { id: HOLD_B, organizationId: ORG_B_ID, userId: UPLOADER_B_ID, permissionSetId: PSET_B },
    ],
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await cleanup();
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("custom roles RLS via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED role name resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () => db.permissionSet.findFirst({ where: { name: SHARED_ROLE_NAME } }));
    const inB = await runWithTenant(ORG_B_ID, () => db.permissionSet.findFirst({ where: { name: SHARED_ROLE_NAME } }));
    // Identity, not count: a count of 1 each also passes if the lanes are swapped.
    expect(inA?.id).toBe(PSET_A);
    expect(inB?.id).toBe(PSET_B);
  });

  it("lane-scoped: the SHARED permission key resolves per lane, and so does the holder", async () => {
    const grantA = await runWithTenant(ORG_A_ID, () => db.permissionSetGrant.findFirst({ where: { permission: SHARED_PERMISSION } }));
    const grantB = await runWithTenant(ORG_B_ID, () => db.permissionSetGrant.findFirst({ where: { permission: SHARED_PERMISSION } }));
    expect(grantA?.id).toBe(GRANT_A);
    expect(grantB?.id).toBe(GRANT_B);
    const holdA = await runWithTenant(ORG_A_ID, () => db.userPermissionSet.findFirst({ where: { permissionSetId: PSET_A } }));
    expect(holdA?.userId).toBe(UPLOADER_A_ID);
  });

  it("cross-tenant miss: B's role is invisible from A's lane, even addressed by id", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.permissionSet.findUnique({ where: { id: PSET_B } }))).toBeNull();
  });

  it("cross-tenant miss: children addressed by the PARENT id miss", async () => {
    // The whole point of the children carrying their own organizationId.
    expect(await runWithTenant(ORG_A_ID, () => db.permissionSetGrant.findMany({ where: { permissionSetId: PSET_B } }))).toHaveLength(0);
    expect(await runWithTenant(ORG_A_ID, () => db.userPermissionSet.findMany({ where: { permissionSetId: PSET_B } }))).toHaveLength(0);
  });

  it("cross-tenant miss: B's holder is invisible from A's lane, even addressed by user id", async () => {
    // The authorisation-relevant shape: "what does this person hold" must not
    // answer across the fence.
    expect(await runWithTenant(ORG_A_ID, () => db.userPermissionSet.findMany({ where: { userId: UPLOADER_B_ID } }))).toHaveLength(0);
  });

  it("fails closed across all three tables with no tenant store", async () => {
    // A permission read outside a lane returns nothing, which reads as "holds
    // no custom role". Safe, and exactly why the session plumbing must borrow
    // the lane rather than run this unwrapped.
    expect(await db.permissionSet.findMany({ where: { name: SHARED_ROLE_NAME } })).toHaveLength(0);
    expect(await db.permissionSetGrant.findMany({ where: { permission: SHARED_PERMISSION } })).toHaveLength(0);
    expect(await db.userPermissionSet.findMany({ where: { id: { in: [HOLD_A, HOLD_B] } } })).toHaveLength(0);
  });

  it("WITH CHECK refuses smuggling a foreign org onto a create", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.permissionSet.create({
          data: { id: "tenancy-pset-smuggled", organizationId: ORG_B_ID, name: "Smuggled" },
        }),
      ),
    ).rejects.toThrow();
    expect(await owner.permissionSet.findUnique({ where: { id: "tenancy-pset-smuggled" } })).toBeNull();
  });

  it("WITH CHECK refuses re-homing a row the lane legitimately owns", async () => {
    // The one write a USING-only policy cannot catch: A owns the row, so it
    // passes the read side, and only WITH CHECK stops it leaving.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.permissionSet.update({ where: { id: PSET_A }, data: { organizationId: ORG_B_ID } }),
      ),
    ).rejects.toThrow();
    const stillA = await owner.permissionSet.findUnique({ where: { id: PSET_A } });
    expect(stillA?.organizationId).toBe(ORG_A_ID);
  });

  it("cross-tenant DELETE hits nothing", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.permissionSet.delete({ where: { id: PSET_B } })),
    ).rejects.toThrow();
    expect(await owner.permissionSet.findUnique({ where: { id: PSET_B } })).not.toBeNull();
  });
});
