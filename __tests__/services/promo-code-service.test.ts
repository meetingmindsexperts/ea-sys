/**
 * Unit tests for src/services/promo-code-service.ts — apply/remove a promo code
 * against an existing registration (organizer + registrant surfaces share this).
 * Mirrors the mock-db + tx-proxy pattern from accommodation-service.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => {
  const registration = { findFirst: vi.fn(), update: vi.fn() };
  const promoCode = { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() };
  const promoCodeRedemption = { deleteMany: vi.fn(), count: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const $queryRaw = vi.fn().mockResolvedValue([{ id: "promo-1" }]);
  return {
    mockDb: {
      registration,
      promoCode,
      promoCodeRedemption,
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ registration, promoCode, promoCodeRedemption, $queryRaw }),
      ),
      $queryRaw,
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { applyPromoCodeToRegistration, removePromoCodeFromRegistration } from "@/services/promo-code-service";

const REG = {
  id: "reg-1",
  eventId: "evt-1",
  paymentStatus: "UNPAID",
  promoCodeId: null as string | null,
  ticketTypeId: "tt-1",
  attendee: { email: "Jane@Example.com" },
  ticketType: { id: "tt-1", price: 100, currency: "USD" },
  pricingTier: null as { id: string; price: number; currency: string } | null,
};

const PROMO = {
  id: "promo-1",
  code: "SAVE10",
  isActive: true,
  discountType: "PERCENTAGE",
  discountValue: 10,
  maxUses: null as number | null,
  maxUsesPerEmail: 1 as number | null,
  validFrom: null as Date | null,
  validUntil: null as Date | null,
  ticketTypes: [] as { ticketTypeId: string }[],
};

const BASE = { registrationId: "reg-1", eventId: "evt-1", code: "save10", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findFirst.mockResolvedValue({ ...REG });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO });
  mockDb.promoCode.update.mockResolvedValue({});
  mockDb.promoCode.updateMany.mockResolvedValue({ count: 1 });
  mockDb.promoCodeRedemption.count.mockResolvedValue(0);
  mockDb.promoCodeRedemption.deleteMany.mockResolvedValue({ count: 1 });
  mockDb.promoCodeRedemption.create.mockResolvedValue({});
  mockDb.promoCodeRedemption.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("applyPromoCodeToRegistration", () => {
  it("applies a percentage discount and records the redemption", async () => {
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.financials).toMatchObject({ code: "SAVE10", originalPrice: 100, discountAmount: 10, finalPrice: 90, currency: "USD" });
    expect(r.replaced).toBe(false);
    // usedCount bumped (maxUses null → plain update), reg updated, redemption created
    expect(mockDb.promoCode.update).toHaveBeenCalledWith(expect.objectContaining({ data: { usedCount: { increment: 1 } } }));
    expect(mockDb.registration.update).toHaveBeenCalledWith(expect.objectContaining({ data: { promoCodeId: "promo-1", discountAmount: 10 } }));
    expect(mockDb.promoCodeRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "jane@example.com", originalPrice: 100, discountAmount: 10, finalPrice: 90 }) }),
    );
  });

  it("acquires a FOR UPDATE row lock on the promo before applying (per-email race guard)", async () => {
    await applyPromoCodeToRegistration(BASE);
    expect(mockDb.$queryRaw).toHaveBeenCalled();
    const call = mockDb.$queryRaw.mock.calls[0];
    const sql = Array.isArray(call?.[0]) ? (call[0] as string[]).join("?") : String(call?.[0]);
    expect(sql).toContain("FOR UPDATE");
  });

  it("caps a FIXED_AMOUNT discount at the base price and uses the tier price", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...REG, pricingTier: { id: "pt-1", price: 40, currency: "EUR" } });
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, discountType: "FIXED_AMOUNT", discountValue: 75 });
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // discount capped at 40 (base), final 0, tier currency
    expect(r.financials).toMatchObject({ originalPrice: 40, discountAmount: 40, finalPrice: 0, currency: "EUR" });
  });

  it("refuses when the registration is already settled", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...REG, paymentStatus: "PAID" });
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r).toMatchObject({ ok: false, code: "ALREADY_SETTLED" });
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
  });

  it("refuses a free registration (nothing to discount)", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...REG, ticketType: { id: "tt-1", price: 0, currency: "USD" } });
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r).toMatchObject({ ok: false, code: "FREE_REGISTRATION" });
  });

  it("refuses an inactive / unknown code", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, isActive: false });
    expect(await applyPromoCodeToRegistration(BASE)).toMatchObject({ ok: false, code: "INVALID_CODE" });
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    expect(await applyPromoCodeToRegistration(BASE)).toMatchObject({ ok: false, code: "INVALID_CODE" });
  });

  it("refuses an expired code", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, validUntil: new Date("2020-01-01") });
    expect(await applyPromoCodeToRegistration(BASE)).toMatchObject({ ok: false, code: "INVALID_CODE" });
  });

  it("refuses when not applicable to the ticket type", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, ticketTypes: [{ ticketTypeId: "other-tt" }] });
    expect(await applyPromoCodeToRegistration(BASE)).toMatchObject({ ok: false, code: "NOT_APPLICABLE" });
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
  });

  it("refuses when maxUses is exhausted (atomic guard returns 0)", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, maxUses: 5 });
    mockDb.promoCode.updateMany.mockResolvedValue({ count: 0 });
    expect(await applyPromoCodeToRegistration(BASE)).toMatchObject({ ok: false, code: "EXHAUSTED" });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("refuses when the per-email limit is hit, excluding this reg's own prior redemption", async () => {
    mockDb.promoCodeRedemption.count.mockResolvedValue(1); // another reg already used it
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r).toMatchObject({ ok: false, code: "EMAIL_LIMIT" });
    // the count query must exclude this registration
    expect(mockDb.promoCodeRedemption.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ NOT: { registrationId: "reg-1" } }) }),
    );
  });

  it("replaces a different existing promo (releases the old one first)", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...REG, promoCodeId: "old-promo" });
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(true);
    // old redemption deleted + old usedCount decremented
    expect(mockDb.promoCodeRedemption.deleteMany).toHaveBeenCalledWith({ where: { registrationId: "reg-1" } });
    expect(mockDb.promoCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "old-promo", usedCount: { gt: 0 } }), data: { usedCount: { decrement: 1 } } }),
    );
    // new redemption created
    expect(mockDb.promoCodeRedemption.create).toHaveBeenCalled();
  });

  it("is idempotent when the same code is re-applied (no usedCount change)", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ ...REG, promoCodeId: "promo-1" });
    const r = await applyPromoCodeToRegistration(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replaced).toBe(false);
    // no increment, no new redemption — the existing one is refreshed in place
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
    expect(mockDb.promoCodeRedemption.create).not.toHaveBeenCalled();
    expect(mockDb.promoCodeRedemption.updateMany).toHaveBeenCalled();
  });
});

describe("removePromoCodeFromRegistration", () => {
  it("removes an applied promo and clears the registration", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", paymentStatus: "UNPAID", promoCodeId: "promo-1" });
    const r = await removePromoCodeFromRegistration({ registrationId: "reg-1", eventId: "evt-1", source: "registrant" });
    expect(r).toMatchObject({ ok: true, removed: true });
    expect(mockDb.promoCodeRedemption.deleteMany).toHaveBeenCalled();
    expect(mockDb.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { promoCodeId: null, discountAmount: null } }),
    );
  });

  it("is a no-op when no promo is applied", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", paymentStatus: "UNPAID", promoCodeId: null });
    const r = await removePromoCodeFromRegistration({ registrationId: "reg-1", eventId: "evt-1", source: "rest" });
    expect(r).toMatchObject({ ok: true, removed: false });
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("refuses to remove from a settled registration", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", paymentStatus: "PAID", promoCodeId: "promo-1" });
    const r = await removePromoCodeFromRegistration({ registrationId: "reg-1", eventId: "evt-1", source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "ALREADY_SETTLED" });
  });

  it("on a CANCELLED registration: clears fields WITHOUT a second usedCount release (review H6)", async () => {
    // The cancel transition already decremented usedCount; a remove afterwards
    // must not double-release. Fields + redemption row still get cleared so a
    // later reactivation won't re-claim.
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg-1", status: "CANCELLED", paymentStatus: "UNPAID", promoCodeId: "promo-1",
    });
    const r = await removePromoCodeFromRegistration({ registrationId: "reg-1", eventId: "evt-1", source: "rest" });
    expect(r).toMatchObject({ ok: true, removed: true });
    expect(mockDb.promoCodeRedemption.deleteMany).toHaveBeenCalled();
    // No usedCount decrement in either shape.
    expect(mockDb.promoCode.updateMany).not.toHaveBeenCalled();
    expect(mockDb.promoCode.update).not.toHaveBeenCalled();
    expect(mockDb.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { promoCodeId: null, discountAmount: null } }),
    );
  });
});
