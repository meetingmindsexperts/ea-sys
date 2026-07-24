/**
 * MediaFile fast-follow (Phase 2, domain pass #2): the flat per-domain RLS
 * policy from prisma/rls/mediafile.sql — the SAME file the future platform
 * bootstrap applies — enforced end-to-end through the ALS store → SET LOCAL
 * extension → pgbouncer, as the non-owner app_user.
 *
 * SCOPE: this domain gets the DB backstop (defence #2 = RLS) only. The media
 * routes' step-C1 compound-where + step-C3 runWithTenant wiring are a deferred
 * follow-on (they org-bind via findFirst today), so — unlike the Contacts
 * pilot — there is NO compound-where "defence #1 in isolation" assertion here:
 * these tests prove the POLICY, which is exactly what this file adds. The
 * transport correctness (50-lane pooler interleave) + the boot tripwire are
 * model-independent and already pinned on Event / Contact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  UPLOADER_A_ID,
  SHARED_MEDIA_URL,
  MEDIA_A_SHARED_ID,
  MEDIA_B_SHARED_ID,
  ORG_B_ONLY_MEDIA_URL,
  MEDIA_B_ONLY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("MediaFile RLS (prisma/rls/mediafile.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own media", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.mediaFile.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
  });

  it("a DELIBERATELY-unscoped url query cannot read another tenant's media (defence #2)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.mediaFile.findFirst({
        where: { url: ORG_B_ONLY_MEDIA_URL },
        select: { id: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("cross-tenant miss by id: B's media is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.mediaFile.findUnique({ where: { id: MEDIA_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.mediaFile.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("shared url (NOT unique): each lane sees exactly ITS row for the same url", async () => {
    for (const [orgId, expectedId] of [
      [ORG_A_ID, MEDIA_A_SHARED_ID],
      [ORG_B_ID, MEDIA_B_SHARED_ID],
    ] as const) {
      const rows = await runWithTenant(orgId, () =>
        db.mediaFile.findMany({
          where: { url: SHARED_MEDIA_URL },
          select: { id: true, organizationId: true },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(expectedId);
      expect(rows[0].organizationId).toBe(orgId);
    }
  });

  it("WITH CHECK rejects creating media for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.mediaFile.create({
          data: {
            id: "tenancy-mf-smuggled",
            organizationId: ORG_B_ID, // tenant A writing into B
            uploadedById: UPLOADER_A_ID,
            filename: "smuggled.png",
            url: "/uploads/media/2027/01/smuggled.png",
            mimeType: "image/png",
            size: 1024,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN media to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.mediaFile.update({
          where: { id: MEDIA_A_SHARED_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's media cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.mediaFile.delete({ where: { id: MEDIA_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
