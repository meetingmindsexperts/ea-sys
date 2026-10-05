/**
 * Assigned event staff (custom roles Phase 4): the policy from
 * prisma/rls/eventstaffassignment.sql, enforced end to end through the ALS
 * store, the SET LOCAL extension and pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proof: the access checks join this table to decide which
 * events an ASSIGNED-scope person (the desk) may open, so a row must never be
 * readable, deletable or writable from another tenant's lane.
 *
 * Fixtures are seeded HERE on the shared seed's events and users, following
 * the DTCM pool test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID, UPLOADER_A_ID, UPLOADER_B_ID } from "./constants";

const ROW_A_ID = "tenancy-esa-a";
const ROW_B_ID = "tenancy-esa-b";

/** Owner connection: owners bypass the non-FORCE policy, which is what lets us seed both lanes. */
let owner: PrismaClient;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });

  await owner.eventStaffAssignment.deleteMany({ where: { id: { in: [ROW_A_ID, ROW_B_ID] } } });
  await owner.eventStaffAssignment.createMany({
    data: [
      { id: ROW_A_ID, organizationId: ORG_A_ID, eventId: EVENT_A_SHARED_ID, userId: UPLOADER_A_ID },
      { id: ROW_B_ID, organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, userId: UPLOADER_B_ID },
    ],
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await owner?.eventStaffAssignment.deleteMany({ where: { id: { in: [ROW_A_ID, ROW_B_ID, "tenancy-esa-smuggled"] } } });
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("EventStaffAssignment RLS (prisma/rls/eventstaffassignment.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: each lane sees only its own assignments", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.eventStaffAssignment.findMany({ where: { id: { in: [ROW_A_ID, ROW_B_ID] } }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([ROW_A_ID]);
  });

  it("an event lookup through the relation cannot see another tenant's assignment", async () => {
    const events = await runWithTenant(ORG_A_ID, () =>
      db.eventStaffAssignment.count({ where: { eventId: EVENT_B_SHARED_ID, userId: UPLOADER_B_ID } }),
    );
    expect(events).toBe(0);
  });

  it("fails CLOSED with no tenant in the store", async () => {
    const rows = await db.eventStaffAssignment.findMany({ where: { id: { in: [ROW_A_ID, ROW_B_ID] } } });
    expect(rows).toEqual([]);
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () => db.eventStaffAssignment.deleteMany({ where: { id: ROW_B_ID } }));
    expect(res.count).toBe(0);
    const stillThere = await runWithTenant(ORG_B_ID, () =>
      db.eventStaffAssignment.findUnique({ where: { id: ROW_B_ID }, select: { id: true } }),
    );
    expect(stillThere?.id).toBe(ROW_B_ID);
  });

  it("WITH CHECK blocks assigning someone in another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.eventStaffAssignment.createMany({
          data: [{ id: "tenancy-esa-smuggled", organizationId: ORG_B_ID, eventId: EVENT_B_SHARED_ID, userId: UPLOADER_A_ID }],
        }),
      ),
    ).rejects.toThrow();
  });
});
