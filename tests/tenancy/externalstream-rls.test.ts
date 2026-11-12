/**
 * ExternalStream RLS (prisma/rls/webinar.sql): a partner's stream key is
 * visible and writable only in its own organisation's lane (Nov 12, 2026,
 * external streams step 2).
 *
 * The row holds the key a partner publishes with, so a cross-tenant read is a
 * credential leak, not only a data leak. Fixtures are local to this file, like
 * webinar-rls.test.ts: one session and one stream per organisation, plus a
 * spare session in B as the target of the smuggle test.
 *
 * Also pins a known limit: with no tenant in scope the table reads as empty,
 * which is how the MediaMTX publish check (it is handed a key and no tenant)
 * refuses every publish on the platform instance until its lookup moves to
 * the operator lane (ROADMAP, "Webinar streaming", item 2). Master has no RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { ORG_A_ID, ORG_B_ID, EVENT_A_SHARED_ID, EVENT_B_SHARED_ID } from "./constants";

const SESS_A_ID = "ten-xs-sess-a";
const SESS_B_ID = "ten-xs-sess-b";
const SESS_B_SPARE_ID = "ten-xs-sess-b-spare";
const XS_A_ID = "ten-xs-a";
const XS_B_ID = "ten-xs-b";
const XS_SMUGGLED_ID = "ten-xs-smuggled";
const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set: the external-stream fixtures seed as OWNER");
  return new PrismaClient({ datasourceUrl: url });
}

async function seedSession(owner: PrismaClient, id: string, eventId: string) {
  await owner.eventSession.create({
    data: {
      id,
      eventId,
      name: `Partner stream session ${id}`,
      startTime: new Date("2027-02-10T10:00:00Z"),
      endTime: new Date("2027-02-10T11:00:00Z"),
    },
  });
}

beforeAll(async () => {
  const owner = ownerClient();
  try {
    // Idempotent: this file can be re-run alone.
    await owner.externalStream.deleteMany({ where: { id: { in: [XS_A_ID, XS_B_ID, XS_SMUGGLED_ID] } } });
    await owner.eventSession.deleteMany({ where: { id: { in: [SESS_A_ID, SESS_B_ID, SESS_B_SPARE_ID] } } });

    await seedSession(owner, SESS_A_ID, EVENT_A_SHARED_ID);
    await seedSession(owner, SESS_B_ID, EVENT_B_SHARED_ID);
    await seedSession(owner, SESS_B_SPARE_ID, EVENT_B_SHARED_ID);
    await owner.externalStream.create({
      data: { id: XS_A_ID, sessionId: SESS_A_ID, eventId: EVENT_A_SHARED_ID, organizationId: ORG_A_ID, streamKey: KEY_A },
    });
    await owner.externalStream.create({
      data: { id: XS_B_ID, sessionId: SESS_B_ID, eventId: EVENT_B_SHARED_ID, organizationId: ORG_B_ID, streamKey: KEY_B },
    });
  } finally {
    await owner.$disconnect();
  }
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("ExternalStream RLS (prisma/rls/webinar.sql) via the SET LOCAL extension", () => {
  it("each organisation sees only its own partner stream", async () => {
    const a = await runWithTenant(ORG_A_ID, () => db.externalStream.findMany({ select: { id: true, organizationId: true } }));
    const b = await runWithTenant(ORG_B_ID, () => db.externalStream.findMany({ select: { id: true } }));
    expect(a).toEqual([{ id: XS_A_ID, organizationId: ORG_A_ID }]);
    expect(b.map((r) => r.id)).toEqual([XS_B_ID]);
  });

  it("another organisation's key cannot be read by id, by session or by the key itself", async () => {
    const [byId, bySession, byKey] = await runWithTenant(ORG_A_ID, () =>
      Promise.all([
        db.externalStream.findUnique({ where: { id: XS_B_ID }, select: { streamKey: true } }),
        db.externalStream.findFirst({ where: { sessionId: SESS_B_ID }, select: { streamKey: true } }),
        db.externalStream.findFirst({ where: { streamKey: KEY_B }, select: { id: true } }),
      ]),
    );
    expect(byId).toBeNull();
    expect(bySession).toBeNull();
    expect(byKey).toBeNull();
  });

  it("fail-closed: with no tenant in scope the table reads as empty, so a tenant-less key lookup finds nothing", async () => {
    expect(await db.externalStream.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.externalStream.findFirst({ where: { streamKey: KEY_A }, select: { id: true } })).toBeNull();
  });

  it("WITH CHECK rejects issuing a key into ANOTHER organisation", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.externalStream.create({
          data: {
            id: XS_SMUGGLED_ID,
            sessionId: SESS_B_SPARE_ID,
            eventId: EVENT_B_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            streamKey: "c".repeat(32),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("another organisation's key cannot be replaced, switched off or deleted", async () => {
    const touched = await runWithTenant(ORG_A_ID, () =>
      db.externalStream.updateMany({ where: { id: XS_B_ID }, data: { secretVersion: { increment: 1 }, enabled: false } }),
    );
    expect(touched.count).toBe(0);
    await expect(
      runWithTenant(ORG_A_ID, () => db.externalStream.delete({ where: { id: XS_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });

    const owner = ownerClient();
    try {
      const row = await owner.externalStream.findUnique({ where: { id: XS_B_ID }, select: { secretVersion: true, enabled: true } });
      expect(row).toEqual({ secretVersion: 1, enabled: true });
    } finally {
      await owner.$disconnect();
    }
  });

  it("an organisation cannot move its own key to another organisation (WITH CHECK on update)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.externalStream.update({ where: { id: XS_A_ID }, data: { organizationId: ORG_B_ID } })),
    ).rejects.toThrow(/row-level security|denied/i);
  });
});
