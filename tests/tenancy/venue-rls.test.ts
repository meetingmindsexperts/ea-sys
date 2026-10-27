/**
 * The online venue's three tables (born tenant-correct, Oct 8 2026; proven here by the tenancy review of Oct 27):
 * the policies in prisma/rls/venue.sql enforced end to end through the ALS store, the SET LOCAL extension and
 * pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs, each in the shape the venue's services write:
 *   - VenueActivity is keyed (eventId, userId), and a userId is a plain string, so the SAME person id sits in
 *     both lanes. The page's save is an upsert by that key (saveMyActivity): from the wrong lane it must neither
 *     read nor overwrite the other tenant's row.
 *   - VenueReport is append-only and created with INSERT..RETURNING (createReport), which a strict USING rejects
 *     even when the WITH CHECK would admit it: the Domain-#18/#19 lesson, so the own-lane create is asserted too.
 *   - VenueAiUsage is the daily AI cap, claimed with a guarded increment (claimReply). A claim made from the
 *     wrong lane must count nothing: otherwise one tenant could use up, or reset, another tenant's day.
 *
 * Fixtures are seeded here on the shared seed's events, as the DTCM and travel-grant suites do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID } from "./constants";

/** One person id in both lanes: a plain string, as the venue stores it. */
const SHARED_USER = "tenancy-venue-user";
const DAY = "2027-01-15";
const ACT_A = "tenancy-venue-act-a";
const ACT_B = "tenancy-venue-act-b";
const REP_A = "tenancy-venue-rep-a";
const REP_B = "tenancy-venue-rep-b";
const USE_A = "tenancy-venue-use-a";
const USE_B = "tenancy-venue-use-b";

let owner: PrismaClient;

async function clean() {
  await owner.venueActivity.deleteMany({ where: { userId: { startsWith: "tenancy-venue-" } } });
  await owner.venueReport.deleteMany({ where: { reporterId: { startsWith: "tenancy-venue-" } } });
  await owner.venueAiUsage.deleteMany({ where: { day: DAY } });
}

beforeAll(async () => {
  process.env.RLS_SET_LOCAL = "1";
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });
  await clean();
  await owner.venueActivity.createMany({
    data: [
      { id: ACT_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, userId: SHARED_USER, data: { lane: "a" } },
      { id: ACT_B, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, userId: SHARED_USER, data: { lane: "b" } },
    ],
  });
  await owner.venueReport.createMany({
    data: [
      { id: REP_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, reporterId: SHARED_USER, data: { lane: "a" } },
      { id: REP_B, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, reporterId: SHARED_USER, data: { lane: "b" } },
    ],
  });
  await owner.venueAiUsage.createMany({
    data: [
      { id: USE_A, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, day: DAY, replies: 5 },
      { id: USE_B, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, day: DAY, replies: 7 },
    ],
  });
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  if (owner) await clean();
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("VenueActivity RLS (prisma/rls/venue.sql)", () => {
  it("lane-scoped: the same person id resolves to each lane's own row", async () => {
    const inA = await runWithTenant(ORG_A_ID, () => db.venueActivity.findMany({ where: { userId: SHARED_USER }, select: { id: true } }));
    expect(inA.map((r) => r.id)).toEqual([ACT_A]);
    const inB = await runWithTenant(ORG_B_ID, () => db.venueActivity.findMany({ where: { userId: SHARED_USER }, select: { id: true } }));
    expect(inB.map((r) => r.id)).toEqual([ACT_B]);
  });

  it("cross-tenant read by the (eventId, userId) key misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      db.venueActivity.findUnique({ where: { eventId_userId: { eventId: EVENT_B_SHARED_ID, userId: SHARED_USER } } }),
    );
    expect(found).toBeNull();
  });

  it("fails CLOSED with no tenant in the store", async () => {
    expect(await db.venueActivity.findMany({ where: { userId: SHARED_USER } })).toEqual([]);
  });

  it("the page's upsert from the wrong lane cannot overwrite the other tenant's row", async () => {
    // saveMyActivity's shape. Prisma runs it as INSERT .. ON CONFLICT DO UPDATE: the insert stamped for B fails
    // WITH CHECK, and the conflict arm would have to update B's existing row, which lane A's USING hides, so
    // either way it is refused. B's row stays as it was.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.venueActivity.upsert({
          where: { eventId_userId: { eventId: EVENT_B_SHARED_ID, userId: SHARED_USER } },
          create: { eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, userId: SHARED_USER, data: { lane: "smuggled" } },
          update: { data: { lane: "smuggled" } },
        }),
      ),
    ).rejects.toThrow();
    const b = await owner.venueActivity.findUnique({ where: { id: ACT_B }, select: { data: true } });
    expect(b?.data).toEqual({ lane: "b" });
  });

  it("the page's upsert on its own lane works", async () => {
    await runWithTenant(ORG_A_ID, () =>
      db.venueActivity.upsert({
        where: { eventId_userId: { eventId: EVENT_A_SHARED_ID, userId: SHARED_USER } },
        create: { eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, userId: SHARED_USER, data: { lane: "a" } },
        update: { data: { lane: "a", saved: 2 } },
      }),
    );
    const a = await owner.venueActivity.findUnique({ where: { id: ACT_A }, select: { data: true } });
    expect(a?.data).toEqual({ lane: "a", saved: 2 });
  });
});

describe("VenueReport RLS (prisma/rls/venue.sql)", () => {
  it("the team's list sees only its own lane's reports", async () => {
    const inA = await runWithTenant(ORG_A_ID, () => db.venueReport.findMany({ where: { reporterId: SHARED_USER }, select: { id: true } }));
    expect(inA.map((r) => r.id)).toEqual([REP_A]);
  });

  it("WITH CHECK blocks filing a report into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.venueReport.create({ data: { eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, reporterId: "tenancy-venue-smuggler", data: {} } }),
      ),
    ).rejects.toThrow();
  });

  it("accepts createReport's shape on its own lane: create returning the id", async () => {
    const row = await runWithTenant(ORG_A_ID, () =>
      db.venueReport.create({ data: { eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, reporterId: "tenancy-venue-probe", data: {} }, select: { id: true } }),
    );
    expect(row.id).toBeTruthy();
    const fromB = await runWithTenant(ORG_B_ID, () => db.venueReport.findUnique({ where: { id: row.id }, select: { id: true } }));
    expect(fromB).toBeNull();
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () => db.venueReport.deleteMany({ where: { id: REP_B } }));
    expect(res.count).toBe(0);
    expect(await owner.venueReport.findUnique({ where: { id: REP_B }, select: { id: true } })).not.toBeNull();
  });
});

describe("VenueAiUsage RLS (prisma/rls/venue.sql)", () => {
  it("a claim from the wrong lane counts nothing against the other tenant's day", async () => {
    // claimReply's guarded increment, aimed at B's event from A's lane.
    const claimed = await runWithTenant(ORG_A_ID, () =>
      db.venueAiUsage.updateMany({ where: { eventId: EVENT_B_SHARED_ID, day: DAY, replies: { lt: 2000 } }, data: { replies: { increment: 1 } } }),
    );
    expect(claimed.count).toBe(0);
    expect((await owner.venueAiUsage.findUnique({ where: { id: USE_B }, select: { replies: true } }))?.replies).toBe(7);
  });

  it("cross-tenant read of the day's count by its key misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () => db.venueAiUsage.findUnique({ where: { eventId_day: { eventId: EVENT_B_SHARED_ID, day: DAY } } }));
    expect(found).toBeNull();
  });

  it("re-homing a day's count to another tenant is refused", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.venueAiUsage.updateMany({ where: { id: USE_A }, data: { organizationId: ORG_B_ID } })),
    ).rejects.toThrow();
  });

  it("claimReply's shape works on its own lane", async () => {
    const claimed = await runWithTenant(ORG_A_ID, () =>
      db.venueAiUsage.updateMany({ where: { eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, day: DAY, replies: { lt: 2000 } }, data: { replies: { increment: 1 } } }),
    );
    expect(claimed.count).toBe(1);
    expect((await owner.venueAiUsage.findUnique({ where: { id: USE_A }, select: { replies: true } }))?.replies).toBe(6);
  });
});
