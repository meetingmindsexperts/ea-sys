/**
 * BillingAccount sweep (Phase 2, domain pass #3 — the first FULL finance
 * sweep): the flat per-domain RLS policy from prisma/rls/billingaccount.sql —
 * the SAME file the future platform bootstrap applies — enforced end-to-end
 * through the ALS store → SET LOCAL extension → pgbouncer, as the non-owner
 * app_user.
 *
 * Unlike MediaFile (policy-only), BillingAccount got the full recipe: the
 * service compound-where's its mutations + uses tenantTransaction (C1) and all
 * 8 route handlers wrap in runWithTenant (C2). So this proves BOTH layers
 * independently, like the Contacts pilot:
 *   - defence #1 (compound-where) blocks a cross-org write even with RLS out of
 *     the picture (owner connection bypasses the non-FORCE policy);
 *   - defence #2 (RLS) blocks a deliberately-unscoped read.
 *
 * Transport correctness (50-lane pooler interleave) + the boot tripwire are
 * model-independent and already pinned on Event / Contact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  SHARED_PAYER_NAME,
  BILLING_A_SHARED_ID,
  BILLING_B_SHARED_ID,
  ORG_B_ONLY_PAYER_NAME,
  BILLING_B_ONLY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("BillingAccount RLS (prisma/rls/billingaccount.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own payers", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.billingAccount.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
  });

  it("a DELIBERATELY-unscoped name query cannot read another tenant's payer (defence #2)", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.billingAccount.findFirst({
        where: { name: ORG_B_ONLY_PAYER_NAME },
        select: { id: true },
      }),
    );
    expect(leaked).toBeNull();
  });

  it("cross-tenant miss by id: B's payer is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.billingAccount.findUnique({ where: { id: BILLING_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.billingAccount.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("per-org unique name: each lane sees exactly ITS payer for the shared name", async () => {
    for (const [orgId, expectedId] of [
      [ORG_A_ID, BILLING_A_SHARED_ID],
      [ORG_B_ID, BILLING_B_SHARED_ID],
    ] as const) {
      const rows = await runWithTenant(orgId, () =>
        db.billingAccount.findMany({
          where: { name: SHARED_PAYER_NAME },
          select: { id: true, organizationId: true },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(expectedId);
      expect(rows[0].organizationId).toBe(orgId);
    }
  });

  it("WITH CHECK rejects creating a payer for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.billingAccount.create({
          data: {
            id: "tenancy-ba-smuggled",
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled Payer",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN payer to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.billingAccount.update({
          where: { id: BILLING_A_SHARED_ID, organizationId: ORG_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's payer cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.billingAccount.delete({ where: { id: BILLING_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: compound-where blocks a cross-org update even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy, so this exercises ONLY the
    // C1 compound-where layer — the shape updateBillingAccount/mergeBillingAccounts
    // now use. Guard: TENANCY_DIRECT_URL must be the OWNER connection, else
    // PrismaClient falls back to the pooled app_user and tests the wrong layer.
    if (!process.env.TENANCY_DIRECT_URL) {
      throw new Error("TENANCY_DIRECT_URL must be set — this test requires the OWNER connection");
    }
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      await expect(
        owner.billingAccount.update({
          where: { id: BILLING_B_ONLY_ID, organizationId: ORG_A_ID },
          data: { name: "Hijacked" },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      // ...and the row is untouched.
      const row = await owner.billingAccount.findUnique({
        where: { id: BILLING_B_ONLY_ID },
        select: { name: true },
      });
      expect(row?.name).toBe(ORG_B_ONLY_PAYER_NAME);
    } finally {
      await owner.$disconnect();
    }
  });
});
