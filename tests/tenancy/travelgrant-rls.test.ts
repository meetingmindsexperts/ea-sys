/**
 * Travel Grant (born tenancy-compliant, Aug 25 2026): the policy from
 * prisma/rls/travelgrant.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store, the SET LOCAL extension
 * and pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - `token` is GLOBALLY unique and plaintext, because the organizer copies
 *     the link out of the console. So a cross-tenant findUnique({ token }) must
 *     MISS rather than resolve. This is the property that forces the public
 *     route to bootstrap the org from the Event by host+slug BEFORE the token
 *     lookup: get that ordering backwards and every link fail-closes on the
 *     platform while passing every test on master, where RLS is off.
 *   - `speakerId` is also globally unique (one grant per Speaker row, and
 *     Speaker is itself event-scoped, which is how decision D2 is enforced).
 *     A cross-tenant findUnique({ speakerId }) must miss too.
 *   - The policy is SYMMETRIC and strict: there is no null-org carve-out, and
 *     there should not be. Unlike EmailLog and AuditLog, every row is created
 *     from an Event that necessarily has an organization, so an org-less write
 *     is a bug and is asserted to be REJECTED.
 *
 * Fixtures are seeded HERE rather than in prisma/seed-tenancy.ts. That file and
 * constants.ts are shared, and a parallel session was editing this checkout on
 * the day this was written; the webinar sweep took the same decision for the
 * same reason. It reuses the speakers the seed already creates, so it adds no
 * new constants. Fold it into the seed when the shared files are quiet.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, SPEAKER_A_ID, SPEAKER_B_ID } from "./constants";

const GRANT_A_ID = "tenancy-tg-a";
const GRANT_B_ID = "tenancy-tg-b";
const TOKEN_A = "tenancy-tg-token-a";
const TOKEN_B = "tenancy-tg-token-b";

/** Owner connection: owners bypass the non-FORCE policy, which is what lets us seed both lanes. */
let owner: PrismaClient;

beforeAll(async () => {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL (owner, raw :5432) is required to seed fixtures");
  owner = new PrismaClient({ datasources: { db: { url } } });

  const speakers = await owner.speaker.findMany({
    where: { id: { in: [SPEAKER_A_ID, SPEAKER_B_ID] } },
    select: { id: true, eventId: true, event: { select: { organizationId: true } } },
  });
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const a = byId.get(SPEAKER_A_ID);
  const b = byId.get(SPEAKER_B_ID);
  if (!a || !b) throw new Error("seed fixtures missing: run the tenancy seed first");

  await owner.travelGrant.deleteMany({ where: { id: { in: [GRANT_A_ID, GRANT_B_ID] } } });
  await owner.travelGrant.createMany({
    data: [
      { id: GRANT_A_ID, eventId: a.eventId, organizationId: ORG_A_ID, speakerId: a.id, token: TOKEN_A },
      { id: GRANT_B_ID, eventId: b.eventId, organizationId: ORG_B_ID, speakerId: b.id, token: TOKEN_B },
    ],
  });

  process.env.RLS_SET_LOCAL = "1";
});

afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await owner?.travelGrant.deleteMany({ where: { id: { in: [GRANT_A_ID, GRANT_B_ID] } } });
  await owner?.$disconnect();
  await db.$disconnect();
});

describe("TravelGrant RLS (prisma/rls/travelgrant.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: each tenant sees only its own grant", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.travelGrant.findMany({ select: { id: true } }),
    );
    expect(inA.map((r) => r.id)).toEqual([GRANT_A_ID]);

    const inB = await runWithTenant(ORG_B_ID, () =>
      db.travelGrant.findMany({ select: { id: true } }),
    );
    expect(inB.map((r) => r.id)).toEqual([GRANT_B_ID]);
  });

  it("cross-tenant findUnique by TOKEN misses, which is why the org must be resolved first", async () => {
    // The token is global and plaintext. If this ever returned B's row inside
    // A's lane, the public form would render another tenant's author.
    const found = await runWithTenant(ORG_A_ID, () =>
      db.travelGrant.findUnique({ where: { token: TOKEN_B } }),
    );
    expect(found).toBeNull();
  });

  it("cross-tenant findUnique by speakerId misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      db.travelGrant.findUnique({ where: { speakerId: SPEAKER_B_ID } }),
    );
    expect(found).toBeNull();
  });

  it("fails CLOSED with no tenant in the store", async () => {
    // What a query that forgot its wrap would see. Zero rows is the safe answer.
    const rows = await db.travelGrant.findMany({ select: { id: true } });
    expect(rows).toEqual([]);
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.travelGrant.deleteMany({ where: { id: GRANT_B_ID } }),
    );
    expect(res.count).toBe(0);

    const stillThere = await runWithTenant(ORG_B_ID, () =>
      db.travelGrant.findUnique({ where: { id: GRANT_B_ID }, select: { id: true } }),
    );
    expect(stillThere?.id).toBe(GRANT_B_ID);
  });

  it("cross-tenant UPDATE of the consent fields touches nothing", async () => {
    // The write that matters most: forging a consent on another tenant's row.
    const res = await runWithTenant(ORG_A_ID, () =>
      db.travelGrant.updateMany({
        where: { id: GRANT_B_ID },
        data: { status: "CONSENTED", signedName: "forged" },
      }),
    );
    expect(res.count).toBe(0);

    const untouched = await runWithTenant(ORG_B_ID, () =>
      db.travelGrant.findUnique({ where: { id: GRANT_B_ID }, select: { status: true, signedName: true } }),
    );
    expect(untouched).toEqual({ status: "PENDING", signedName: null });
  });

  it("WITH CHECK blocks smuggling a row into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.travelGrant.createMany({
          data: [
            {
              id: "tenancy-tg-smuggled",
              eventId: "tenancy-ev-b-shared",
              organizationId: ORG_B_ID,
              speakerId: "tenancy-sp-b-only",
              token: "tenancy-tg-token-smuggled",
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("WITH CHECK blocks re-homing an existing row to another tenant", async () => {
    // The one write a compound where cannot catch: the row IS in this lane and
    // the update tries to move it out.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.travelGrant.updateMany({
          where: { id: GRANT_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it("REJECTS an org-less row: there is no null-org carve-out here", async () => {
    // Every grant is created from an Event, which always has an organization,
    // so an org-less write is a bug rather than a legitimate shape.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.travelGrant.createMany({
          data: [
            {
              id: "tenancy-tg-orgless",
              eventId: "tenancy-ev-a-shared",
              organizationId: null,
              speakerId: "tenancy-sp-a",
              token: "tenancy-tg-token-orgless",
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });
});
