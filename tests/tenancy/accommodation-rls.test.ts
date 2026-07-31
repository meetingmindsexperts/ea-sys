/**
 * Accommodation domain sweep (Domain #10): the flat policies from
 * prisma/rls/accommodation.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, across Hotel + RoomType + Accommodation.
 *
 * Domain-specific proofs beyond the standard set:
 *   - Hotel/RoomType carry no per-org-unique field — BOTH orgs hold a hotel on
 *     the SAME name (SHARED_HOTEL_NAME), so an unscoped by-name lookup returns
 *     only the caller's row (the MediaFile shared-url shape);
 *   - RoomType is 2-hop (hotelId → Hotel → Event); its backfilled column is
 *     proven lane-scoped independently of its parent;
 *   - Accommodation is 1-hop from Event; its lane is proven independently.
 *
 * No defence-#1-in-isolation assertion: the accommodation mutations bind the org
 * via a prior org-scoped load (the CRM/CrmContact precedent), not a write-side
 * compound-where, so there is no eventId-bound write shape to isolate here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import {
  ORG_A_ID,
  ORG_B_ID,
  EVENT_A_SHARED_ID,
  SHARED_HOTEL_NAME,
  HOTEL_A_ID,
  HOTEL_B_ID,
  ROOMTYPE_A_ID,
  ROOMTYPE_B_ID,
  ACCOMMODATION_A_ID,
  ACCOMMODATION_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Accommodation RLS (prisma/rls/accommodation.sql) via the SET LOCAL extension", () => {
  it("scoped Hotel findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.hotel.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([HOTEL_A_ID]);
  });

  it("the SHARED hotel name resolves per-lane (unscoped by-name lookup)", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.hotel.findMany({ where: { name: SHARED_HOTEL_NAME }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.hotel.findMany({ where: { name: SHARED_HOTEL_NAME }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([HOTEL_A_ID]);
    expect(b.map((r) => r.id)).toEqual([HOTEL_B_ID]);
  });

  it("cross-tenant miss by id: B's Hotel is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.hotel.findUnique({ where: { id: HOTEL_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("RoomType (2-hop backfill) is lane-scoped: per-lane count + cross-tenant by-id miss + own visible", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.roomType.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.roomType.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.roomType.findUnique({ where: { id: ROOMTYPE_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    const own = await runWithTenant(ORG_A_ID, () =>
      db.roomType.findUnique({ where: { id: ROOMTYPE_A_ID }, select: { id: true } }),
    );
    expect(own?.id).toBe(ROOMTYPE_A_ID);
  });

  it("Accommodation (1-hop) is lane-scoped: own findMany + cross-tenant by-id miss", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.accommodation.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.map((r) => r.id)).toEqual([ACCOMMODATION_A_ID]);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.accommodation.findUnique({ where: { id: ACCOMMODATION_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows on all 3 tables", async () => {
    expect(await db.hotel.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.roomType.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.accommodation.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a Hotel for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.hotel.create({
          data: {
            id: "tenancy-hotel-smuggled",
            eventId: EVENT_A_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled Inn",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN Hotel to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.hotel.update({
          where: { id: HOTEL_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's Accommodation cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.accommodation.delete({ where: { id: ACCOMMODATION_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });
});
