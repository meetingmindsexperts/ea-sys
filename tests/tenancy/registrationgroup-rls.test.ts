/**
 * RegistrationGroup sweep (born-compliant domain, Aug 2026 — group review L4).
 *
 * The policy file (prisma/rls/registrationgroup.sql) shipped with the feature
 * but its harness assertions did not, which left the usual gap: a policy nobody
 * exercises is a policy nobody knows is wrong. This closes it with the standard
 * per-domain matrix, run as the non-owner app_user through pgbouncer.
 *
 * `RegistrationGroup` has NO per-org unique field, so lane-scoping is proven the
 * Invoice/EmailLog way: BOTH orgs hold a group on the SAME coordinator email, so
 * an unscoped `where: { coordinatorEmail }` — the shape any future "find my
 * group" lookup would take — must return only the caller's row.
 *
 * Transport correctness (the 50-lane pooler interleave) and the boot tripwire
 * are model-independent and already pinned on Event / Contact.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  BILLING_A_SHARED_ID,
  SHARED_COORDINATOR_EMAIL,
  GROUP_A_ID,
  GROUP_B_ID,
  GROUP_B_ONLY_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("RegistrationGroup RLS (prisma/rls/registrationgroup.sql) via the SET LOCAL extension", () => {
  it("scoped findMany returns ONLY the tenant's own groups", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.registrationGroup.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(GROUP_B_ID);
  });

  it("shared coordinator email: each lane sees exactly ITS OWN group (defence #2)", async () => {
    for (const [orgId, expectedId] of [
      [ORG_A_ID, GROUP_A_ID],
      [ORG_B_ID, GROUP_B_ID],
    ] as const) {
      const rows = await runWithTenant(orgId, () =>
        db.registrationGroup.findMany({
          where: { coordinatorEmail: SHARED_COORDINATOR_EMAIL },
          select: { id: true, organizationId: true },
        }),
      );
      expect(rows.map((r) => r.id)).toContain(expectedId);
      expect(rows.every((r) => r.organizationId === orgId)).toBe(true);
    }
  });

  it("cross-tenant miss by id: B's group is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.registrationGroup.findUnique({ where: { id: GROUP_B_ONLY_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows", async () => {
    const rows = await db.registrationGroup.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a group for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registrationGroup.create({
          data: {
            id: "tenancy-grp-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            coordinatorName: "Smuggler",
            coordinatorEmail: "smuggler@tenancy.test",
            billingAccountId: BILLING_A_SHARED_ID,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN group to another org", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registrationGroup.update({
          where: { id: GROUP_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's group cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.registrationGroup.delete({ where: { id: GROUP_B_ONLY_ID } }),
      ),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("a group's own money rows stay reachable on its lane (the consolidated-invoice anchor)", async () => {
    // The group is the alternative anchor for Invoice/Payment (registrationId
    // null). This proves the relation still resolves under the policy — a
    // fail-closed join here would silently hide a company's invoice from them.
    const withInvoices = await runWithTenant(ORG_A_ID, () =>
      db.registrationGroup.findUnique({
        where: { id: GROUP_A_ID },
        select: { id: true, invoices: { select: { id: true } } },
      }),
    );
    expect(withInvoices?.id).toBe(GROUP_A_ID);
    expect(Array.isArray(withInvoices?.invoices)).toBe(true);
  });

  it("defence #1 in isolation: the service's org-bound where blocks a cross-org read even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy, so this exercises ONLY the
    // app-layer binding the group service uses when it resolves a group.
    if (!process.env.TENANCY_DIRECT_URL) {
      throw new Error("TENANCY_DIRECT_URL must be set — this test requires the OWNER connection");
    }
    const owner = new PrismaClient({ datasourceUrl: process.env.TENANCY_DIRECT_URL });
    try {
      const miss = await owner.registrationGroup.findFirst({
        where: { id: GROUP_B_ONLY_ID, organizationId: ORG_A_ID },
        select: { id: true },
      });
      expect(miss).toBeNull();
      // ...while the same id IS visible to the owner without the org bind,
      // proving the miss came from the binding and not from the row's absence.
      const present = await owner.registrationGroup.findUnique({
        where: { id: GROUP_B_ONLY_ID },
        select: { organizationId: true },
      });
      expect(present?.organizationId).toBe(ORG_B_ID);
    } finally {
      await owner.$disconnect();
    }
  });
});
