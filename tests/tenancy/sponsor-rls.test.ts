/**
 * Sponsor (promoted out of settings JSON, Sep 2 2026): the policy from
 * prisma/rls/sponsor.sql, the SAME file the platform bootstrap applies,
 * enforced end to end through the ALS store, the SET LOCAL extension and
 * pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - Both orgs deliberately hold a sponsor NAMED "Abbott". Sponsors are drawn
 *     from a small pool of real pharmaceutical companies, so two tenants
 *     sharing one is the NORMAL case rather than a contrived fixture, and it is
 *     the case where a leak would be most damaging: learning which of your
 *     rivals a sponsor also backs is competitive intelligence.
 *   - The FOREIGN KEY reads are exercised, not just the table. `sponsorId` is
 *     an FK from both Registration and PromoCode as of migration
 *     20260902160000, and a join is the shape the reporting query uses, so a
 *     policy that scoped the table while leaving the relation readable would
 *     pass a naive test and leak through the join.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID } from "./constants";

const SPONSOR_A_ID = "tenancy-sponsor-a";
const SPONSOR_B_ID = "tenancy-sponsor-b";
const PROMO_A_ID = "tenancy-sponsor-promo-a";
const PROMO_B_ID = "tenancy-sponsor-promo-b";
/** Both tenants back the same real company. That is ordinary, and it is the leak that would hurt. */
const SHARED_NAME = "Abbott";

let owner: PrismaClient;

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });

  await owner.promoCode.deleteMany({ where: { id: { in: [PROMO_A_ID, PROMO_B_ID] } } });
  await owner.sponsor.deleteMany({ where: { id: { in: [SPONSOR_A_ID, SPONSOR_B_ID] } } });
  await owner.sponsor.createMany({
    data: [
      { id: SPONSOR_A_ID, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, name: SHARED_NAME, tier: "gold" },
      { id: SPONSOR_B_ID, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, name: SHARED_NAME, tier: "platinum" },
    ],
  });
  await owner.promoCode.createMany({
    data: [
      { id: PROMO_A_ID, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, code: "ABBOTT-A", discountType: "PERCENTAGE", discountValue: 10, sponsorId: SPONSOR_A_ID },
      { id: PROMO_B_ID, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, code: "ABBOTT-B", discountType: "PERCENTAGE", discountValue: 20, sponsorId: SPONSOR_B_ID },
    ],
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await owner?.promoCode.deleteMany({ where: { id: { in: [PROMO_A_ID, PROMO_B_ID] } } });
  await owner?.sponsor.deleteMany({ where: { id: { in: [SPONSOR_A_ID, SPONSOR_B_ID] } } });
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("Sponsor RLS (prisma/rls/sponsor.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED sponsor name resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.sponsor.findMany({ where: { name: SHARED_NAME }, select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([SPONSOR_A_ID]);

    const inB = await runWithTenant(ORG_B_ID, () =>
      db.sponsor.findMany({ where: { name: SHARED_NAME }, select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([SPONSOR_B_ID]);
  });

  it("cross-tenant by-id read misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () => db.sponsor.findUnique({ where: { id: SPONSOR_B_ID } }));
    expect(found).toBeNull();
  });

  it("does not leak THROUGH the promo-code relation, which is how reporting reads it", async () => {
    // The reporting query is `{ promoCode: { sponsorId } }`. A policy on the
    // table alone, with the relation readable, would pass every test above and
    // leak here, so the join is asserted rather than assumed.
    const viaJoin = await runWithTenant(ORG_A_ID, () =>
      db.promoCode.findMany({
        where: { sponsor: { name: SHARED_NAME } },
        select: { id: true, sponsor: { select: { id: true, name: true } } },
      }),
    );
    expect(viaJoin.map((r) => r.id)).toEqual([PROMO_A_ID]);
    expect(viaJoin[0]?.sponsor?.id).toBe(SPONSOR_A_ID);
  });

  it("fails CLOSED with no tenant in the store", async () => {
    expect(await db.sponsor.findMany({ where: { name: SHARED_NAME } })).toEqual([]);
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () => db.sponsor.deleteMany({ where: { id: SPONSOR_B_ID } }));
    expect(res.count).toBe(0);
    const stillThere = await runWithTenant(ORG_B_ID, () =>
      db.sponsor.findUnique({ where: { id: SPONSOR_B_ID }, select: { id: true } }),
    );
    expect(stillThere?.id).toBe(SPONSOR_B_ID);
  });

  it("WITH CHECK blocks smuggling a sponsor into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.sponsor.createMany({
          data: [{ id: "tenancy-sponsor-smuggled", eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, name: "Smuggled" }],
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("WITH CHECK blocks re-homing an owned sponsor to another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.sponsor.updateMany({ where: { id: SPONSOR_A_ID }, data: { organizationId: ORG_B_ID } }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });
});
