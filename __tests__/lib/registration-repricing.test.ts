/**
 * resolveRepricing — the shared re-tier / type-change repricing resolver used by
 * BOTH the REST PUT and the MCP `update_registration` tool (so they can't drift).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    ticketType: { findFirst: vi.fn() },
    pricingTier: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { resolveRepricing } from "@/lib/registration-repricing";

const OLD_TYPE = "cttold";
const NEW_TYPE = "cttnew";
const TIER = "ctier1";

function existing(over: Record<string, unknown> = {}) {
  return {
    ticketTypeId: OLD_TYPE,
    pricingTierId: null as string | null,
    paymentStatus: "UNPAID" as never,
    promoCodeId: null as string | null,
    discountAmount: null as unknown,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.ticketType.findFirst.mockResolvedValue({ price: 250 }); // effective type base
  mockDb.pricingTier.findFirst.mockResolvedValue({ id: TIER, price: 500 });
});

describe("resolveRepricing", () => {
  it("no type/tier change → leaves everything unchanged", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing() });
    expect(r).toEqual({ ok: true, isChangingType: false, effectiveTypeId: OLD_TYPE, nextTierId: undefined, originalPrice: undefined });
  });

  it("re-tier (same type) validates against the current type + reprices", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing(), pricingTierId: TIER });
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TIER, ticketTypeId: OLD_TYPE } }));
    expect(r).toMatchObject({ ok: true, nextTierId: TIER, originalPrice: 500 });
  });

  it("re-tier to base (null) reprices to the type's base", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ pricingTierId: TIER }), pricingTierId: null });
    expect(r).toMatchObject({ ok: true, nextTierId: null, originalPrice: 250 });
  });

  it("type + tier validates the tier against the NEW type", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing(), ticketTypeId: NEW_TYPE, pricingTierId: TIER });
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TIER, ticketTypeId: NEW_TYPE } }));
    expect(r).toMatchObject({ ok: true, isChangingType: true, effectiveTypeId: NEW_TYPE, nextTierId: TIER, originalPrice: 500 });
  });

  it("tier not under the effective type → PRICING_TIER_NOT_FOUND (404)", async () => {
    mockDb.pricingTier.findFirst.mockResolvedValue(null);
    const r = await resolveRepricing({ eventId: "ev", existing: existing(), ticketTypeId: NEW_TYPE, pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "PRICING_TIER_NOT_FOUND", status: 404 });
  });

  it("bare type change (unpaid, no tier) → tier null + reprice to new base (M2)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing(), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: true, isChangingType: true, nextTierId: null, originalPrice: 250 });
  });

  it("bare type change on a PAID reg → tier null, NO reprice", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "PAID" }), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: true, nextTierId: null, originalPrice: undefined });
  });

  it("re-tier on a PAID reg → TIER_CHANGE_REQUIRES_UNPAID (400)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "PAID" }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_REQUIRES_UNPAID", status: 400 });
  });

  it("re-tier with a promo applied → TIER_CHANGE_HAS_DISCOUNT (400)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ promoCodeId: "promo1" }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT", status: 400 });
  });

  it("re-tier with a stored discount amount → TIER_CHANGE_HAS_DISCOUNT (400)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ discountAmount: 100 }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT", status: 400 });
  });
});
