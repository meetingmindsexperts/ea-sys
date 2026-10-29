/**
 * GET /api/events/[eventId]/registrations/walk-in/promo: the desk checks a
 * walk-in's code before taking money (Oct 29, 2026). Read-only, and the same
 * rules the redemption applies (src/lib/promo-redeem.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    promoCode: { findUnique: vi.fn() },
    promoCodeRedemption: { count: vi.fn() },
  },
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (...a: unknown[]) => mockRateLimit(...a) }));

import { GET } from "@/app/api/events/[eventId]/registrations/walk-in/promo/route";

const session = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const get = (query: string) => GET(new Request(`http://x/api/events/evt-1/registrations/walk-in/promo?${query}`), params);

const PROMO = {
  id: "promo-1",
  code: "SAVE20",
  isActive: true,
  validFrom: null,
  validUntil: null,
  ticketTypes: [],
  sponsorId: null,
  sponsorCoversFee: false,
  sponsor: null,
  discountType: "PERCENTAGE",
  discountValue: 20,
  maxUses: null as number | null,
  usedCount: 0,
  maxUsesPerEmail: null as number | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockRateLimit.mockReturnValue({ allowed: true });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.ticketType.findFirst.mockResolvedValue({ price: 0, pricingTiers: [{ price: 500 }] });
  mockDb.promoCode.findUnique.mockResolvedValue(PROMO);
  mockDb.promoCodeRedemption.count.mockResolvedValue(0);
});

describe("GET walk-in/promo", () => {
  it("prices a discount code at the chosen rate", async () => {
    const res = await get("code=save20&ticketTypeId=tt1&pricingTierId=tier1");
    expect(await res.json()).toMatchObject({ valid: true, code: "SAVE20", originalPrice: 500, discountAmount: 100, finalPrice: 400, sponsorName: null });
    expect(mockDb.promoCode.findUnique.mock.calls[0][0].where).toEqual({ eventId_code: { eventId: "evt-1", code: "SAVE20" } });
  });

  it("names the sponsor for a code that covers the fee", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, discountValue: 100, sponsorId: "sp1", sponsorCoversFee: true, sponsor: { name: "Pfizer" } });
    const res = await get("code=PFIZER&ticketTypeId=tt1&pricingTierId=tier1&sponsor=1");
    expect(await res.json()).toMatchObject({ valid: true, finalPrice: 0, sponsorName: "Pfizer" });
  });

  it("asked for a sponsor code, refuses a discount code", async () => {
    const res = await get("code=SAVE20&ticketTypeId=tt1&sponsor=1");
    expect(await res.json()).toMatchObject({ valid: false, code: "PROMO_CODE_NOT_SPONSOR" });
  });

  it("reports a used-up code and a code this email already used", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, maxUses: 3, usedCount: 3 });
    expect(await (await get("code=SAVE20&ticketTypeId=tt1")).json()).toMatchObject({ valid: false, code: "PROMO_CODE_EXHAUSTED" });
    mockDb.promoCode.findUnique.mockResolvedValue({ ...PROMO, maxUsesPerEmail: 1 });
    mockDb.promoCodeRedemption.count.mockResolvedValue(1);
    expect(await (await get("code=SAVE20&ticketTypeId=tt1&email=a%40b.com")).json()).toMatchObject({ valid: false, code: "PROMO_CODE_EMAIL_LIMIT" });
  });

  it("an unknown code is invalid, not an error", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    const res = await get("code=NOPE&ticketTypeId=tt1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: false, code: "INVALID_PROMO_CODE" });
  });

  it("refuses a missing code with 400, an event outside the caller's scope with 404", async () => {
    expect((await get("ticketTypeId=tt1")).status).toBe(400);
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await get("code=SAVE20&ticketTypeId=tt1")).status).toBe(404);
  });
});
