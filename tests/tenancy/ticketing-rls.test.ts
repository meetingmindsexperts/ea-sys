/**
 * Ticketing follow-on sweep (Domain #8 carve-off): the flat policies from
 * prisma/rls/ticketing.sql — the SAME file the future platform bootstrap
 * applies — enforced end-to-end through the ALS store → SET LOCAL extension →
 * pgbouncer, as the non-owner app_user, across the 5 ticketing tables
 * (TicketType, PricingTier, PromoCode, PromoCodeRedemption, PromoCodeTicketType).
 *
 * Domain-specific proofs beyond the standard set:
 *   - PricingTier is 2-hop (ticketTypeId → TicketType → Event) — its backfilled
 *     column is proven lane-scoped independently of its parent;
 *   - PromoCode: BOTH orgs hold a code on the SAME string (TENANCY10) — an
 *     unscoped by-code lookup returns only the caller's row (`@@unique([eventId,
 *     code])` lets the strings coexist);
 *   - defence #1 in isolation (owner bypasses the non-FORCE policy): the C1
 *     eventId-bound updateMany shape used by the tickets CRUD routes
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
  EVENT_B_SHARED_ID,
  TICKET_TYPE_A_ID,
  TICKET_TYPE_B_ID,
  PRICING_TIER_B_ID,
  SHARED_PROMO_CODE,
  PROMO_CODE_A_ID,
  PROMO_CODE_B_ID,
  PROMO_REDEMPTION_A_ID,
  PROMO_REDEMPTION_B_ID,
  PROMO_LINK_B_ID,
} from "./constants";

beforeAll(() => {
  process.env.RLS_SET_LOCAL = "1";
});
afterAll(async () => {
  delete process.env.RLS_SET_LOCAL;
  await db.$disconnect();
});

describe("Ticketing RLS (prisma/rls/ticketing.sql) via the SET LOCAL extension", () => {
  it("scoped TicketType findMany returns ONLY the tenant's own rows", async () => {
    const rows = await runWithTenant(ORG_A_ID, () =>
      db.ticketType.findMany({ select: { id: true, organizationId: true } }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === ORG_A_ID)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([TICKET_TYPE_A_ID]);
  });

  it("cross-tenant miss by id: B's TicketType is invisible under A's store", async () => {
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.ticketType.findUnique({ where: { id: TICKET_TYPE_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("PricingTier (2-hop backfill) is lane-scoped: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.pricingTier.count())).toBe(1);
    expect(await runWithTenant(ORG_B_ID, () => db.pricingTier.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.pricingTier.findUnique({ where: { id: PRICING_TIER_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("PromoCode: the SHARED code string resolves per-lane (unscoped by-code lookup)", async () => {
    const a = await runWithTenant(ORG_A_ID, () =>
      db.promoCode.findMany({ where: { code: SHARED_PROMO_CODE }, select: { id: true } }),
    );
    const b = await runWithTenant(ORG_B_ID, () =>
      db.promoCode.findMany({ where: { code: SHARED_PROMO_CODE }, select: { id: true } }),
    );
    expect(a.map((r) => r.id)).toEqual([PROMO_CODE_A_ID]);
    expect(b.map((r) => r.id)).toEqual([PROMO_CODE_B_ID]);
  });

  it("PromoCodeRedemption: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.promoCodeRedemption.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.promoCodeRedemption.findUnique({ where: { id: PROMO_REDEMPTION_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
    const own = await runWithTenant(ORG_A_ID, () =>
      db.promoCodeRedemption.findUnique({ where: { id: PROMO_REDEMPTION_A_ID }, select: { id: true } }),
    );
    expect(own?.id).toBe(PROMO_REDEMPTION_A_ID);
  });

  it("PromoCodeTicketType link: per-lane count + cross-tenant by-id miss", async () => {
    expect(await runWithTenant(ORG_A_ID, () => db.promoCodeTicketType.count())).toBe(1);
    const leaked = await runWithTenant(ORG_A_ID, () =>
      db.promoCodeTicketType.findUnique({ where: { id: PROMO_LINK_B_ID }, select: { id: true } }),
    );
    expect(leaked).toBeNull();
  });

  it("fail-closed: flag on but NO tenant store → zero rows on every ticketing table", async () => {
    expect(await db.ticketType.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.pricingTier.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.promoCode.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.promoCodeRedemption.findMany({ select: { id: true } })).toHaveLength(0);
    expect(await db.promoCodeTicketType.findMany({ select: { id: true } })).toHaveLength(0);
  });

  it("WITH CHECK rejects creating a TicketType for ANOTHER tenant", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.ticketType.create({
          data: {
            id: "tenancy-tt-smuggled",
            eventId: EVENT_B_SHARED_ID,
            organizationId: ORG_B_ID, // tenant A writing into B
            name: "Smuggled",
          },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("org-re-homing UPDATE is blocked: A cannot move its OWN TicketType to another org (WITH CHECK)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () =>
        db.ticketType.update({
          where: { id: TICKET_TYPE_A_ID },
          data: { organizationId: ORG_B_ID },
        }),
      ),
    ).rejects.toThrow(/row-level security|denied/i);
  });

  it("cross-tenant DELETE misses: B's PromoCode cannot be deleted under A's store (USING)", async () => {
    await expect(
      runWithTenant(ORG_A_ID, () => db.promoCode.delete({ where: { id: PROMO_CODE_B_ID } })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("defence #1 in isolation: the { id, eventId } updateMany shape matches zero rows even with RLS bypassed (owner)", async () => {
    // The owner role bypasses the non-FORCE policy — this exercises ONLY the C1
    // layer: the tickets CRUD routes' { id, eventId } update/delete binding.
    const owner = ownerClient();
    try {
      const res = await owner.ticketType.updateMany({
        where: { id: TICKET_TYPE_B_ID, eventId: EVENT_A_SHARED_ID },
        data: { description: "hijacked" },
      });
      expect(res.count).toBe(0);
      const row = await owner.ticketType.findUnique({
        where: { id: TICKET_TYPE_B_ID },
        select: { description: true },
      });
      expect(row?.description).toBeNull();
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
