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

  // Owner, Nov 13, 2026: the agent's update_registration sends only the type. The price was
  // re-stamped and the old discount kept: 250 off a 500 type, moved to a 200 type, read as
  // nothing owed. Refused like the tier change, which the sheet's own type change already was.
  it.each(["UNPAID", "UNASSIGNED", "PENDING"])("bare type change on a %s reg with a promo code is refused, nothing re-stamped", async (paymentStatus) => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus, promoCodeId: "promo1", discountAmount: 250 }), ticketTypeId: NEW_TYPE });
    expect(r).toEqual({
      ok: false,
      code: "TIER_CHANGE_HAS_DISCOUNT",
      status: 400,
      message: "Remove the applied promo code / discount before changing the tier or type, then re-apply it if needed.",
    });
  });

  it("bare type change with a stored discount and no code is refused too", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ discountAmount: 100 }), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT" });
  });

  it.each(["COMPLIMENTARY", "INCLUSIVE"])("bare type change on a %s reg with a sponsor's code is still allowed (nothing is owed)", async (paymentStatus) => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus, promoCodeId: "promo1", discountAmount: 250 }), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: true, isChangingType: true, nextTierId: null, originalPrice: 250 });
  });

  // Review of cbead69f: the exemption is judged on the status the registration ENDS with.
  it("a COMPLIMENTARY reg made UNPAID in the same call is refused: it would owe under the old discount", async () => {
    const r = await resolveRepricing({
      eventId: "ev", existing: existing({ paymentStatus: "COMPLIMENTARY", promoCodeId: "promo1", discountAmount: 200 }),
      ticketTypeId: NEW_TYPE, nextPaymentStatus: "UNPAID",
    });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT" });
  });

  it("an UNPAID reg marked PAID in the same call is refused too: a paid row must not carry a stale discount", async () => {
    const r = await resolveRepricing({
      eventId: "ev", existing: existing({ promoCodeId: "promo1", discountAmount: 250 }),
      ticketTypeId: NEW_TYPE, nextPaymentStatus: "PAID",
    });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT" });
  });

  it.each(["COMPLIMENTARY", "INCLUSIVE"])("an UNPAID reg made %s in the same call is allowed: it ends owing nothing", async (next) => {
    const r = await resolveRepricing({
      eventId: "ev", existing: existing({ promoCodeId: "promo1", discountAmount: 250 }),
      ticketTypeId: NEW_TYPE, nextPaymentStatus: next as "COMPLIMENTARY" | "INCLUSIVE",
    });
    expect(r).toMatchObject({ ok: true, isChangingType: true, nextTierId: null, originalPrice: 250 });
  });

  it("a PAID reg with a promo code changes type as before: its price is not touched", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "PAID", promoCodeId: "promo1", discountAmount: 250 }), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: true, nextTierId: null, originalPrice: undefined });
  });

  it("sending the same type is not a type change, so a promo code blocks nothing", async () => {
    const same = existing({ promoCodeId: "promo1", discountAmount: 250 });
    const r = await resolveRepricing({ eventId: "ev", existing: same, ticketTypeId: same.ticketTypeId ?? undefined });
    expect(r).toMatchObject({ ok: true, isChangingType: false, originalPrice: undefined });
  });

  it("bare type change on a PAID reg → tier null, NO reprice", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "PAID" }), ticketTypeId: NEW_TYPE });
    expect(r).toMatchObject({ ok: true, nextTierId: null, originalPrice: undefined });
  });

  it("re-tier on a PAID reg → TIER_CHANGE_REQUIRES_UNPAID (400)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "PAID" }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_REQUIRES_UNPAID", status: 400 });
  });

  // Oct 22, 2026 (owner): nothing is owed, so the tier is a label.
  it.each(["COMPLIMENTARY", "INCLUSIVE"])("re-tier on a %s reg is allowed and re-stamps the price", async (paymentStatus) => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: true, nextTierId: TIER });
  });

  // Review M + L (Oct 22, 2026): for nothing-owed regs, "type change + tier cleared"
  // is a bare type change: a sponsor promo does not block it, and the sheet and
  // the MCP tool reprice the same way.
  it.each(["COMPLIMENTARY", "INCLUSIVE"])("%s: type change clearing the tier is not blocked by a promo", async (paymentStatus) => {
    const r = await resolveRepricing({
      eventId: "ev", existing: existing({ paymentStatus, promoCodeId: "promo1", pricingTierId: "old-tier" }),
      ticketTypeId: NEW_TYPE, pricingTierId: null,
    });
    expect(r).toMatchObject({ ok: true, isChangingType: true, nextTierId: null, originalPrice: 250 });
  });

  it("COMPLIMENTARY: the sheet's tier-cleared type change and a bare one give the same result", async () => {
    const sheet = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "COMPLIMENTARY" }), ticketTypeId: NEW_TYPE, pricingTierId: null });
    const bare = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus: "COMPLIMENTARY" }), ticketTypeId: NEW_TYPE });
    expect(sheet).toEqual(bare);
  });

  it("UNPAID with a promo: clearing the tier on a type change is still refused (unchanged)", async () => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ promoCodeId: "promo1" }), ticketTypeId: NEW_TYPE, pricingTierId: null });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_HAS_DISCOUNT" });
  });

  it.each(["REFUNDED", "FAILED"])("re-tier on a %s reg stays refused", async (paymentStatus) => {
    const r = await resolveRepricing({ eventId: "ev", existing: existing({ paymentStatus }), pricingTierId: TIER });
    expect(r).toMatchObject({ ok: false, code: "TIER_CHANGE_REQUIRES_UNPAID" });
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
