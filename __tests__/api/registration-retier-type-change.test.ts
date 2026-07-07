/**
 * Registration PUT — unified re-tier AND ticket-type-change repricing.
 *
 * The organizer can now change the ticket type AND pick a pricing tier for the
 * NEW type in one Save: the tier is validated against the effective (new) type
 * and `originalPrice` is re-stamped so every finance surface reflects it. Guards
 * (unpaid-only, no-promo, tier-belongs-to-type) still apply. Bare type change
 * with no tier keeps the old behaviour (tier nulled, price left as-is).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, captured } = vi.hoisted(() => {
  const captured: { updateManyData?: Record<string, unknown> } = {};
  const tx = {
    registration: {
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
        captured.updateManyData = args.data;
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(),
    },
    ticketType: { findUnique: vi.fn().mockResolvedValue({ name: "Nurse" }) },
    attendee: { update: vi.fn().mockResolvedValue({}) },
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    promoCode: { update: vi.fn().mockResolvedValue({}) },
  };
  return {
    captured,
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
      billingAccount: { findFirst: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      // PUT recomputes `financials` including the credited-so-far sum.
      invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { total: null } }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockAuth: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/utils", () => ({ normalizeTag: (t: string) => t, generateBarcode: () => "BC" }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/storage", () => ({ deletePhoto: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/webinar", () => ({ readSponsors: () => [] }));
vi.mock("@/lib/registration-seat", () => ({
  planSeatTransition: () => ({ release: null, claim: null }),
  needsQrCode: () => false,
  holdsSeat: () => true,
  seatCounter: () => ({ kind: "ticketType", id: "x" }),
}));
vi.mock("@/lib/registration-seat-db", () => ({
  releaseSeat: vi.fn().mockResolvedValue(undefined),
  claimSeat: vi.fn().mockResolvedValue(true),
}));
// auth-guards, event-access, finance-visibility, registration-financials,
// optimistic-lock, schemas are REAL (pure).

import { PUT } from "@/app/api/events/[eventId]/registrations/[registrationId]/route";

const OLD_TYPE = "coldtype0001";
const NEW_TYPE = "cnewtype0001";
const NEW_TIER = "cnewtier0001";
const OLD_TIER = "coldtier0001";
const NOW = "2026-07-07T10:00:00.000Z";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
function req(body: Record<string, unknown>) {
  return new Request("http://localhost/x", {
    method: "PUT",
    body: JSON.stringify({ expectedUpdatedAt: NOW, ...body }),
    headers: { "content-type": "application/json" },
  });
}

function existingReg(over: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    eventId: "ev1",
    attendeeId: "att1",
    ticketTypeId: OLD_TYPE,
    pricingTierId: OLD_TIER,
    paymentStatus: "UNPAID",
    status: "CONFIRMED",
    attendanceMode: "IN_PERSON",
    createdSource: "ADMIN_DASHBOARD",
    qrCode: "QR",
    promoCodeId: null,
    discountAmount: null,
    originalPrice: 400,
    sponsorId: null,
    updatedAt: new Date(NOW),
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com", country: "AE" },
    ...over,
  };
}

// Shape the tx returns for the response builder (financials are real).
function returnedReg(over: Record<string, unknown> = {}) {
  return {
    id: "reg1", eventId: "ev1", status: "CONFIRMED", paymentStatus: "UNPAID",
    attendanceMode: "IN_PERSON", originalPrice: 500, discountAmount: null,
    ticketType: { id: NEW_TYPE, name: "Nurse", price: 0, currency: "USD" },
    pricingTier: { id: NEW_TIER, name: "Early Bird", price: 500, currency: "USD" },
    attendee: { id: "att1", firstName: "A", lastName: "B", email: "a@b.com" },
    payments: [], accommodation: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  captured.updateManyData = undefined;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {}, taxRate: null, taxLabel: null });
  // new-type existence (line ~482) + base-price lookup share this stub.
  mockDb.ticketType.findFirst.mockResolvedValue({ id: NEW_TYPE, price: 250 });
  mockDb._tx.registration.findUniqueOrThrow.mockResolvedValue(returnedReg());
});

describe("PUT — type change + tier together (unified reprice)", () => {
  it("validates the tier against the NEW type and re-stamps originalPrice", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg());
    // tier belongs to the NEW type
    mockDb.pricingTier.findFirst.mockResolvedValue({ id: NEW_TIER, price: 500 });

    const res = await PUT(req({ ticketTypeId: NEW_TYPE, pricingTierId: NEW_TIER }), { params });
    expect(res.status).toBeLessThan(400);
    // tier lookup was scoped to the NEW type
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NEW_TIER, ticketTypeId: NEW_TYPE } }),
    );
    expect(captured.updateManyData).toMatchObject({
      ticketTypeId: NEW_TYPE,
      pricingTierId: NEW_TIER,
      originalPrice: 500,
    });
  });

  it("rejects a tier that belongs to the OLD type (404 PRICING_TIER_NOT_FOUND)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg());
    // tier not found under the new type
    mockDb.pricingTier.findFirst.mockResolvedValue(null);

    const res = await PUT(req({ ticketTypeId: NEW_TYPE, pricingTierId: OLD_TIER }), { params });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("PRICING_TIER_NOT_FOUND");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("type change + base (null tier) reprices to the NEW type's base price", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg());
    mockDb.ticketType.findFirst.mockResolvedValue({ id: NEW_TYPE, price: 250 });

    const res = await PUT(req({ ticketTypeId: NEW_TYPE, pricingTierId: null }), { params });
    expect(res.status).toBeLessThan(400);
    expect(captured.updateManyData).toMatchObject({
      ticketTypeId: NEW_TYPE,
      pricingTierId: null,
      originalPrice: 250,
    });
  });

  it("bare type change (no tier provided, unpaid) nulls the tier and reprices to the NEW type's base (M2)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg());
    mockDb.ticketType.findFirst.mockResolvedValue({ id: NEW_TYPE, price: 250 });

    const res = await PUT(req({ ticketTypeId: NEW_TYPE }), { params });
    expect(res.status).toBeLessThan(400);
    expect(captured.updateManyData?.pricingTierId).toBe(null);
    expect(captured.updateManyData?.originalPrice).toBe(250);
  });

  it("bare type change on a PAID reg does NOT reprice (they already paid)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ paymentStatus: "PAID" }));

    const res = await PUT(req({ ticketTypeId: NEW_TYPE }), { params });
    expect(res.status).toBeLessThan(400);
    expect(captured.updateManyData?.pricingTierId).toBe(null);
    expect(captured.updateManyData).not.toHaveProperty("originalPrice");
  });
});

describe("PUT — same-type re-tier (regression)", () => {
  it("validates against the current type and reprices", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg());
    mockDb.pricingTier.findFirst.mockResolvedValue({ id: NEW_TIER, price: 350 });

    const res = await PUT(req({ pricingTierId: NEW_TIER }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb.pricingTier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NEW_TIER, ticketTypeId: OLD_TYPE } }),
    );
    expect(captured.updateManyData).toMatchObject({ pricingTierId: NEW_TIER, originalPrice: 350 });
  });
});

describe("PUT — reprice guards apply to type+tier too", () => {
  it("PAID reg → 400 TIER_CHANGE_REQUIRES_UNPAID", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ paymentStatus: "PAID" }));
    mockDb.pricingTier.findFirst.mockResolvedValue({ id: NEW_TIER, price: 500 });

    const res = await PUT(req({ ticketTypeId: NEW_TYPE, pricingTierId: NEW_TIER }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TIER_CHANGE_REQUIRES_UNPAID");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("reg with a promo/discount → 400 TIER_CHANGE_HAS_DISCOUNT", async () => {
    mockDb.registration.findFirst.mockResolvedValue(existingReg({ discountAmount: 100 }));
    mockDb.pricingTier.findFirst.mockResolvedValue({ id: NEW_TIER, price: 500 });

    const res = await PUT(req({ ticketTypeId: NEW_TYPE, pricingTierId: NEW_TIER }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TIER_CHANGE_HAS_DISCOUNT");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
