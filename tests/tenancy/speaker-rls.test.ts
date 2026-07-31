/**
 * Speaker domain sweep: the flat policies from prisma/rls/speaker.sql — the SAME
 * file the future platform bootstrap applies — enforced end-to-end through the
 * ALS store → SET LOCAL extension → pgbouncer, as the non-owner app_user, across
 * Speaker + SpeakerDocument.
 *
 * Domain-specific proofs beyond the standard set:
 *   - Speaker.email is only @@unique([eventId, email]) — BOTH orgs hold a speaker
 *     on the SAME email (SHARED_SPEAKER_EMAIL, different events), so an unscoped
 *     by-email lookup returns only the caller's row (the ticketing shared-code
 *     shape);
 *   - SpeakerDocument is 2-hop (speakerId → Speaker → Event) — its backfilled
 *     column is proven lane-scoped independently of its parent;
 *   - defence #1 in isolation (owner bypasses the non-FORCE policy): the C1
 *     eventId-bound updateMany shape used by the speaker mutation routes
 *     ({ id, eventId }) matches ZERO rows for a wrong-event binding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  SHARED_SPEAKER_EMAIL,
  SPEAKER_A_ID,
  SPEAKER_B_ID,
  SPEAKER_DOC_A_ID,
  SPEAKER_DOC_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Speaker RLS (prisma/rls/speaker.sql) via the SET LOCAL extension", () => {
  it("scoped Speaker findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.speaker.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([SPEAKER_A_ID]);
  });

  it("the SHARED speaker email resolves per-lane (unscoped by-email lookup)", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.speaker.findMany({ where: { email: SHARED_SPEAKER_EMAIL }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.speaker.findMany({ where: { email: SHARED_SPEAKER_EMAIL }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([SPEAKER_A_ID]);
    expect(b.map((r) => r.id)).toEqual([SPEAKER_B_ID]);
  });

  it("cross-tenant miss by id: B's Speaker is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.speaker.findUnique({ where: { id: SPEAKER_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("SpeakerDocument (2-hop backfill) is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.speakerDocument.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.speakerDocument.count())).toBe(2);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.speakerDocument.findUnique({ where: { id: SPEAKER_DOC_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    const own = await runWithTenant(ORG_A_ID, () =>
      db.speakerDocument.findUnique({ where: { id: SPEAKER_DOC_A_ID }, select: { id: true } }),
    );
    expect(own?.id).toBe(SPEAKER_DOC_A_ID);
  });

  it("fail-closed: flag on but NO tenant store → zero rows on both speaker tables", async () => {
    expect(await db.speaker.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.speakerDocument.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a Speaker for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.speaker.create({
          data: {
            id: "tenancy-sp-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            email: "smuggled@tenancy.test",
            firstName: "S",
            lastName: "Muggled",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN Speaker to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.speaker.update({
          where: { id: SPEAKER_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's SpeakerDocument cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.speakerDocument.delete({ where: { id: SPEAKER_DOC_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: the { id, eventId } updateMany shape matches zero rows even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy — this exercises ONLY the C1
    // layer: speaker-service.updateSpeaker binds its optimistic update with
    // { id: speakerId, eventId }, so a wrong-event id matches zero rows.
    const owner = ownerClient();
    try {
      const res = await owner.speaker.updateMany({
        where: { id: SPEAKER_B_ID, eventId: EVENT_A_SHARED_ID },
        data: { bio: "hijacked" },
      });
      expect(res.count).toBe(0);
      const row = await owner.speaker.findUnique({
        where: { id: SPEAKER_B_ID },
        select: { bio: true },
      });
      expect(row?.bio).toBeNull();
    } finally {
      await owner.$disconnect();
    }
  });
});

function ownerClient(): PrismaClient {
  const url = process.env.TENANCY_DIRECT_URL;
  if (!url) throw new Error("TENANCY_DIRECT_URL must be set — defence-#1 tests require the OWNER connection");
  return new PrismaClient({ datasourceUrl: url });
}
