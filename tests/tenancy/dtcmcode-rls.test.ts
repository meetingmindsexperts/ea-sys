/**
 * DTCM code pool (born tenancy-compliant, Aug 25 2026): the policy from
 * prisma/rls/dtcmcode.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store, the SET LOCAL extension
 * and pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - `code` is unique per EVENT, not globally, so BOTH orgs deliberately hold
 *     the SAME value in their pools. An unscoped read by code resolving to the
 *     caller's own row is what proves scoping (the MediaFile shared-url shape),
 *     and it is not hypothetical here: two Dubai organisers can be issued
 *     overlapping blocks, and one tenant must never learn that from a lookup.
 *   - The pool is written with createMany (the importer's shape) as well as
 *     create, because create issues INSERT..RETURNING, which a strict USING
 *     rejects even for a row the WITH CHECK admits — the Domain-#18/#19 lesson.
 *
 * Fixtures are seeded HERE rather than in prisma/seed-tenancy.ts, following the
 * travel-grant and webinar sweeps: it reuses the events the shared seed already
 * creates, so it adds no new shared constants. Fold it into the seed when those
 * files are next touched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID } from "./constants";

const CODE_A_ID = "tenancy-dtcm-a";
const CODE_B_ID = "tenancy-dtcm-b";
/** Both orgs hold this one. Scoping is what makes each see only its own row. */
const SHARED_CODE = "DTCM-SHARED-0001";

/** Owner connection: owners bypass the non-FORCE policy, which is what lets us seed both lanes. */
let owner: PrismaClient;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });

  await owner.dtcmCode.deleteMany({ where: { id: { in: [CODE_A_ID, CODE_B_ID] } } });
  await owner.dtcmCode.createMany({
    data: [
      { id: CODE_A_ID, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, code: SHARED_CODE },
      { id: CODE_B_ID, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, code: SHARED_CODE },
    ],
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await owner?.dtcmCode.deleteMany({ where: { id: { in: [CODE_A_ID, CODE_B_ID] } } });
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("DtcmCode RLS (prisma/rls/dtcmcode.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED code resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.findMany({ where: { code: SHARED_CODE }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([CODE_A_ID]);

    const inB = await runWithTenant(ORG_B_ID, () =>
      db.dtcmCode.findMany({ where: { code: SHARED_CODE }, select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([CODE_B_ID]);
  });

  it("cross-tenant by-id read misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.findUnique({ where: { id: CODE_B_ID } }),
    );
    expect(found).toBeNull();
  });

  it("cross-tenant read by the composite unique key misses", async () => {
    // The importer's own dedup key. If this leaked, an organiser re-importing a
    // block would be told a code was "already in the pool" because ANOTHER
    // tenant holds it.
    const found = await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.findUnique({
        where: { eventId_code: { eventId: EVENT_B_SHARED_ID, code: SHARED_CODE } },
      }),
    );
    expect(found).toBeNull();
  });

  it("fails CLOSED with no tenant in the store", async () => {
    const rows = await db.dtcmCode.findMany({ where: { code: SHARED_CODE }, select: { id: true } });
    expect(rows).toEqual([]);
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.deleteMany({ where: { id: CODE_B_ID } }),
    );
    expect(res.count).toBe(0);

    const stillThere = await runWithTenant(ORG_B_ID, () =>
      db.dtcmCode.findUnique({ where: { id: CODE_B_ID }, select: { id: true } }),
    );
    expect(stillThere?.id).toBe(CODE_B_ID);
  });

  it("WITH CHECK blocks smuggling a code into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.dtcmCode.createMany({
          data: [
            {
              id: "tenancy-dtcm-smuggled",
              eventId: EVENT_B_SHARED_ID,
              organizationId: ORG_B_ID,
              code: "DTCM-SMUGGLED",
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("WITH CHECK blocks re-homing an existing code to another tenant", async () => {
    // The one write a compound where cannot catch: the row IS in this lane and
    // the update tries to move it out.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.dtcmCode.updateMany({
          where: { id: CODE_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it("accepts the importer's shape: createMany with skipDuplicates on its own lane", async () => {
    const created = await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.createMany({
        data: [
          { id: "tenancy-dtcm-probe", eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, code: "DTCM-PROBE" },
          // Same (eventId, code) as the seeded row — skipDuplicates must drop it.
          { eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, code: SHARED_CODE },
        ],
        skipDuplicates: true,
      }),
    );
    expect(created.count).toBe(1);

    const fromB = await runWithTenant(ORG_B_ID, () =>
      db.dtcmCode.findUnique({ where: { id: "tenancy-dtcm-probe" }, select: { id: true } }),
    );
    expect(fromB).toBeNull();

    await runWithTenant(ORG_A_ID, () =>
      db.dtcmCode.deleteMany({ where: { id: "tenancy-dtcm-probe" } }),
    );
  });
});
