/**
 * Contacts pilot (Phase 2, domain pass #1): the flat per-domain RLS policy
 * from prisma/rls/contact.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user.
 *
 * Also proves the two defence layers INDEPENDENTLY:
 *   - layer 1 (compound-where org-bound mutations, pilot C1) blocks a
 *     cross-org write even with RLS entirely out of the picture (tested via
 *     an OWNER connection, which bypasses the non-FORCE policy);
 *   - layer 2 (RLS) blocks a deliberately-unscoped read the forgotten-filter
 *     class would otherwise leak.
 *
 * No contacts copy of the 50-lane pooler interleave — transport correctness
 * is model-independent and already pinned on Event (rls.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  SHARED_CONTACT_EMAIL,
  CONTACT_A_SHARED_ID,
  CONTACT_B_SHARED_ID,
  ORG_B_ONLY_CONTACT_EMAIL,
  CONTACT_B_ONLY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Contact RLS (prisma/rls/contact.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own contacts", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.contact.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
  });

  it("a DELIBERATELY-unscoped email query cannot read another tenant's contact (defence #2)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.contact.findFirst({
        where: { email: ORG_B_ONLY_CONTACT_EMAIL },
        select: { id: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("cross-tenant miss by id: B's contact is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.contact.findUnique({ where: { id: CONTACT_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.contact.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("per-org unique email: each lane sees exactly ITS row for the shared email", async () => {
    for (const [orgId, expectedId] of [
      [ORG_A_ID, CONTACT_A_SHARED_ID],
      [ORG_B_ID, CONTACT_B_SHARED_ID],
    ] as const) {
      const rows = await runWithTenant(orgId, () =>
        db.contact.findMany({
          where: { email: SHARED_CONTACT_EMAIL },
          select: { id: true, organizationId: true },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(expectedId);
      expect(rows[0].organizationId).toBe(orgId);
    }
  });

  it("WITH CHECK rejects creating a contact for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.contact.create({
          data: {
            id: "tenancy-ct-smuggled",
            organizationId: ORG_B_ID, // tenant A writing into B
            email: "smuggled@tenancy.test",
            firstName: "Smuggled",
            lastName: "Contact",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("defence #1 in isolation: compound-where blocks a cross-org update even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy, so this exercises ONLY
    // the C1 compound-where layer — the shape every contact mutation uses.
    // Guard (review M2): with TENANCY_DIRECT_URL absent, PrismaClient would
    // silently fall back to DATABASE_URL — the POOLED app_user — and this
    // test would quietly run WITH RLS active, testing the wrong layer.
    if (!process.env.TENANCY_DIRECT_URL) {
      throw new Error("TENANCY_DIRECT_URL must be set — this test requires the OWNER connection");
    }
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      await expect(
        owner.contact.update({
          where: { id: CONTACT_B_ONLY_ID, organizationId: ORG_A_ID },
          data: { firstName: "Hijacked" },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      // ...and the row is untouched.
      const row = await owner.contact.findUnique({
        where: { id: CONTACT_B_ONLY_ID },
        select: { firstName: true },
      });
      expect(row?.firstName).toBe("Tenancy");
    } finally {
      await owner.$disconnect();
    }
  });

  it("both layers: the same compound-where cross-org update fails as app_user too", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.contact.update({
          where: { id: CONTACT_B_ONLY_ID, organizationId: ORG_A_ID },
          data: { firstName: "Hijacked" },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN row to another org (WITH CHECK)", async () => {
    // The one UPDATE shape compound-where does NOT catch: the where matches
    // (it IS tenant A's row) — only the policy's WITH CHECK on the NEW tuple
    // stops the organizationId from being rewritten to another tenant.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.contact.update({
          where: { id: CONTACT_A_SHARED_ID, organizationId: ORG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's contact cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.contact.delete({ where: { id: CONTACT_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("RLS mechanism tripwire: row_security_active is TRUE as app_user, FALSE as owner", async () => {
    // Pins the exact property the no-FORCE design depends on — and the exact
    // silent failure src/lib/tenant/rls-assert.ts refuses to boot on
    // (review H1): an owner connection bypasses every policy with no error.
    const { assertRlsEnforced } = await import("@/lib/tenant/rls-assert");

    // As the app_user (the pooled harness connection): enforced → resolves.
    await expect(assertRlsEnforced(db)).resolves.toBeUndefined();

    // As the OWNER: bypassed → the assert must refuse.
    if (!process.env.TENANCY_DIRECT_URL) {
      throw new Error("TENANCY_DIRECT_URL must be set — this test requires the OWNER connection");
    }
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      await expect(assertRlsEnforced(owner)).rejects.toThrow(/NOT active|bypasses RLS/i);
    } finally {
      await owner.$disconnect();
    }
  });

  // NOTE (review L3): this test MUTATES CONTACT_A_SHARED_ID's tags and must
  // stay LAST in the file — tests after it must not assume seed-fresh state
  // (the seed re-creates fixtures on the next harness run, not between tests).
  it("tenantTransaction (bulk-tags shape): sequential updates stay scoped; a cross-org id rolls back", async () => {
    // Happy path: A updates its own contact inside the tx.
    const updated = await runWithTenant(ORG_A_ID, () =>
      tenantTransaction(async (tx) => {
        return tx.contact.update({
          where: { id: CONTACT_A_SHARED_ID, organizationId: ORG_A_ID },
          data: { tags: ["tenancy-pilot"] },
          select: { id: true, tags: true },
        });
      }),
    );
    expect(updated.tags).toEqual(["tenancy-pilot"]);

    // A batch containing a cross-org id throws (P2025 — RLS hides the row,
    // the compound where would miss it anyway) and rolls the whole tx back.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        tenantTransaction(async (tx) => {
          await tx.contact.update({
            where: { id: CONTACT_A_SHARED_ID, organizationId: ORG_A_ID },
            data: { tags: ["should-roll-back"] },
          });
          await tx.contact.update({
            where: { id: CONTACT_B_ONLY_ID, organizationId: ORG_A_ID },
            data: { tags: ["never"] },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: "P2025" } satisfies Partial<Prisma.PrismaClientKnownRequestError>);

    // First update rolled back with the tx.
    const after = await runWithTenant(ORG_A_ID, () =>
      db.contact.findUnique({
        where: { id: CONTACT_A_SHARED_ID },
        select: { tags: true },
      }),
    );
    expect(after?.tags).toEqual(["tenancy-pilot"]);
  });
});
