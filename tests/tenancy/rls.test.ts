/**
 * The RLS transport, end-to-end: ALS tenant store → the db.ts SET LOCAL
 * query extension → pgbouncer TRANSACTION pooling → the pilot Event policy.
 * Runs as the NON-owner app_user (owners bypass RLS) via `@/lib/db` with
 * RLS_SET_LOCAL=1.
 *
 * The two assertions that justify this whole harness:
 *  - a DELIBERATELY-unscoped query (simulating a forgotten `where
 *    organizationId`) cannot read another tenant's row — RLS is defence #2;
 *  - 50 interleaved reads across two tenants through the shared pooled
 *    connections never leak a row across lanes (the SET LOCAL + query ride
 *    one transaction = one backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  SHARED_SLUG,
  ORG_B_ONLY_SLUG,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("pilot Event RLS via the SET LOCAL extension (app_user through pgbouncer)", () => {
  it("scoped findMany returns ONLY the tenant's own events", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.event.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
  });

  it("a DELIBERATELY-unscoped query cannot read another tenant's row (defence #2)", async () => {
    // No organizationId in the where — the forgotten-filter class the May/June
    // audits kept finding. RLS must block it anyway.
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.event.findFirst({ where: { slug: ORG_B_ONLY_SLUG }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows (GUC never set)", async () => {
    const rows = await db.event.findMany({ select: { id: true } });
    expect(rows).toHaveLength(0);
  });

  it("50 interleaved cross-tenant reads through the pooler never leak a lane", async () => {
    const lanes = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? ORG_A_ID : ORG_B_ID));
    const results = await Promise.all(
      lanes.map((orgId) =>
        runWithTenant(orgId, async () => {
          const row = await db.event.findFirst({
            where: { slug: SHARED_SLUG },
            select: { id: true, organizationId: true },
          });
          return { orgId, row };
        }),
      ),
    );
    for (const { orgId, row } of results) {
      expect(row?.organizationId).toBe(orgId);
      expect(row?.id).toBe(orgId === ORG_A_ID ? EVENT_A_SHARED_ID : EVENT_B_SHARED_ID);
    }
  });

  it("tenantTransaction: multi-op reads stay scoped on one backend", async () => {
    const { first, count } = await runWithTenant(ORG_A_ID, () =>
      tenantTransaction(async (tx) => {
        const first = await tx.event.findFirst({
          where: { slug: SHARED_SLUG },
          select: { id: true },
        });
        const count = await tx.event.count();
        return { first, count };
      }),
    );
    expect(first?.id).toBe(EVENT_A_SHARED_ID);
    expect(count).toBe(1); // org A holds exactly its one seeded event
  });

  it("tenantTransaction: WITH CHECK rejects writing a row for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        tenantTransaction(async (tx) => {
          await tx.event.create({
            data: {
              id: "tenancy-ev-smuggled",
              organizationId: ORG_B_ID, // tenant A trying to write into B
              name: "Smuggled",
              slug: "smuggled",
              status: "PUBLISHED",
              startDate: new Date("2027-02-01T09:00:00Z"),
              endDate: new Date("2027-02-01T18:00:00Z"),
            },
          });
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });
});
