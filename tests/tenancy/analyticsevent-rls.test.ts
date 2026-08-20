/**
 * Analytics (born tenancy-compliant, Aug 20 2026): the policy from
 * prisma/rls/analyticsevent.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store, the SET LOCAL extension
 * and pgbouncer, as the non-owner app_user.
 *
 * Domain-specific proofs:
 *   - AnalyticsEvent has no per-org unique field, so BOTH orgs carry a hit on
 *     the SAME path and the by-path read resolving to one lane's row is what
 *     proves scoping (the MediaFile shape).
 *   - The policy is SYMMETRIC and strict, unlike EmailLog/AuditLog/HelpChatQuery
 *     which admit NULL-org rows. It can be, because the ingest route DROPS a hit
 *     whose site does not resolve rather than storing it org-less. The
 *     null-org write is therefore asserted to be REJECTED, which is the
 *     opposite of the HelpChatQuery carve-out and is deliberate.
 *   - The production writer uses createMany. create() would issue
 *     INSERT..RETURNING, which the strict USING rejects even for a row the
 *     WITH CHECK admits (the Domain-#18/#19 lesson), so both shapes are pinned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  ANALYTICS_A_ID,
  ANALYTICS_B_ID,
  SHARED_ANALYTICS_PATH,
} from "./constants";

const baseRow = {
  eventId: null,
  siteId: "probe-site",
  name: "pageview",
  path: "/e/probe/register",
  routePattern: "/e/:slug/register",
  visitorHash: "probe-visitor",
  sessionHash: "probe-session",
};

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("AnalyticsEvent RLS (prisma/rls/analyticsevent.sql) via the SET LOCAL extension", () => {
  it("lane-scoped: the SHARED path resolves to each lane's own hit", async () => {
    const inA = await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.findMany({
        where: { path: SHARED_ANALYTICS_PATH },
        select: { id: true },
      }),
    );
    expect(inA.map((r) => r.id)).toEqual([ANALYTICS_A_ID]);

    const inB = await runWithTenant(ORG_B_ID, () =>
      db.analyticsEvent.findMany({
        where: { path: SHARED_ANALYTICS_PATH },
        select: { id: true },
      }),
    );
    expect(inB.map((r) => r.id)).toEqual([ANALYTICS_B_ID]);
  });

  it("cross-tenant by-id read misses", async () => {
    const found = await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.findUnique({ where: { id: ANALYTICS_B_ID } }),
    );
    expect(found).toBeNull();
  });

  it("fails CLOSED with no tenant in the store", async () => {
    // An unset GUC must return nothing, not everything. This is what a query
    // that forgot to wrap would see, and zero rows is the safe direction.
    const rows = await db.analyticsEvent.findMany({
      where: { path: SHARED_ANALYTICS_PATH },
      select: { id: true },
    });
    expect(rows).toEqual([]);
  });

  it("cross-tenant DELETE touches nothing", async () => {
    const res = await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.deleteMany({ where: { id: ANALYTICS_B_ID } }),
    );
    expect(res.count).toBe(0);

    const stillThere = await runWithTenant(ORG_B_ID, () =>
      db.analyticsEvent.findUnique({ where: { id: ANALYTICS_B_ID }, select: { id: true } }),
    );
    expect(stillThere?.id).toBe(ANALYTICS_B_ID);
  });

  it("WITH CHECK blocks smuggling a row into another tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.analyticsEvent.createMany({
          data: [{ id: "tenancy-analytics-smuggled", organizationId: ORG_B_ID, ...baseRow }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("WITH CHECK blocks re-homing an existing row to another tenant", async () => {
    // The one write a compound where cannot catch: the row IS in this lane, and
    // the update tries to move it out of it.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.analyticsEvent.updateMany({
          where: { id: ANALYTICS_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it("REJECTS an org-less row, unlike the EmailLog/AuditLog carve-out", async () => {
    // Deliberately strict. The ingest route drops a hit whose site does not
    // resolve, so an org-less row should never exist; admitting one would force
    // this policy to be permissive for no benefit, and orphan rows would be
    // invisible to every tenant lane anyway.
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.analyticsEvent.createMany({
          data: [{ id: "tenancy-analytics-writer-probe", organizationId: null, ...baseRow }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("accepts the production writer's shape: createMany on the caller's own lane", async () => {
    const created = await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.createMany({
        data: [{ id: "tenancy-analytics-writer-probe", organizationId: ORG_A_ID, ...baseRow }],
      }),
    );
    expect(created.count).toBe(1);

    const readBack = await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.findUnique({
        where: { id: "tenancy-analytics-writer-probe" },
        select: { id: true },
      }),
    );
    expect(readBack?.id).toBe("tenancy-analytics-writer-probe");

    // And it is invisible from the other lane.
    const fromB = await runWithTenant(ORG_B_ID, () =>
      db.analyticsEvent.findUnique({
        where: { id: "tenancy-analytics-writer-probe" },
        select: { id: true },
      }),
    );
    expect(fromB).toBeNull();

    await runWithTenant(ORG_A_ID, () =>
      db.analyticsEvent.deleteMany({ where: { id: "tenancy-analytics-writer-probe" } }),
    );
  });
});
