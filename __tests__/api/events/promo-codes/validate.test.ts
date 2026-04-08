import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    promoCode: { findUnique: vi.fn() },
    promoCodeRedemption: { count: vi.fn() },
    pricingTier: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 9, retryAfterSeconds: 900 })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

import { POST as ValidatePromo } from "@/app/api/public/events/[slug]/validate-promo/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/public/events/test-event/validate-promo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  code: "EARLYBIRD20",
  ticketTypeId: "tt-1",
  email: "test@example.com",
};

const samplePromo = {
  id: "promo-1",
  code: "EARLYBIRD20",
  discountType: "PERCENTAGE",
  discountValue: 20,
  currency: null,
  maxUses: 100,
  maxUsesPerEmail: 1,
  usedCount: 5,
  validFrom: null,
  validUntil: null,
  isActive: true,
  ticketTypes: [],
};

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.ticketType.findFirst.mockResolvedValue({ price: 500 });
  mockDb.promoCodeRedemption.count.mockResolvedValue(0);
});

describe("POST /api/public/events/[slug]/validate-promo", () => {
  it("returns 400 for invalid input (missing code)", async () => {
    const res = await ValidatePromo(
      makeRequest({ ticketTypeId: "tt-1", email: "test@example.com" }),
      makeParams("test-event"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid email", async () => {
    const res = await ValidatePromo(
      makeRequest({ code: "TEST", ticketTypeId: "tt-1", email: "not-an-email" }),
      makeParams("test-event"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when event not found", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await ValidatePromo(makeRequest(validBody), makeParams("bad-slug"));
    expect(res.status).toBe(404);
  });

  it("returns valid=false for non-existent promo code", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(null);
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("Invalid");
  });

  it("returns valid=false for inactive promo code", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({ ...samplePromo, isActive: false });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
  });

  it("returns valid=false when code not yet active (validFrom in future)", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      validFrom: new Date("2099-01-01"),
    });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("not yet active");
  });

  it("returns valid=false when code expired (validUntil in past)", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      validUntil: new Date("2020-01-01"),
    });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("expired");
  });

  it("returns valid=false when max uses reached", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      maxUses: 5,
      usedCount: 5,
    });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("limit");
  });

  it("returns valid=false when per-email limit reached", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(samplePromo);
    mockDb.promoCodeRedemption.count.mockResolvedValue(1); // already used once
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("already used");
  });

  it("returns valid=false when ticket type not applicable", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      ticketTypes: [{ ticketTypeId: "tt-vip" }],
    });
    const res = await ValidatePromo(
      makeRequest({ ...validBody, ticketTypeId: "tt-standard" }),
      makeParams("test-event"),
    );
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.error).toContain("not applicable");
  });

  it("returns valid=true with correct discount for PERCENTAGE", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(samplePromo);
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.code).toBe("EARLYBIRD20");
    expect(data.discountType).toBe("PERCENTAGE");
    expect(data.discountAmount).toBe(100); // 20% of 500
    expect(data.originalPrice).toBe(500);
    expect(data.finalPrice).toBe(400);
  });

  it("returns valid=true with correct discount for FIXED_AMOUNT", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      code: "FLAT50",
      discountType: "FIXED_AMOUNT",
      discountValue: 50,
      currency: "USD",
    });
    const res = await ValidatePromo(
      makeRequest({ ...validBody, code: "FLAT50" }),
      makeParams("test-event"),
    );
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.discountAmount).toBe(50);
    expect(data.finalPrice).toBe(450);
  });

  it("caps FIXED_AMOUNT discount at ticket price", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      discountType: "FIXED_AMOUNT",
      discountValue: 999,
      currency: "USD",
    });
    mockDb.ticketType.findFirst.mockResolvedValue({ price: 100 });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.discountAmount).toBe(100);
    expect(data.finalPrice).toBe(0);
  });

  it("uses pricing tier price when pricingTierId is provided", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(samplePromo);
    mockDb.pricingTier.findFirst.mockResolvedValue({ price: 300 });
    const res = await ValidatePromo(
      makeRequest({ ...validBody, pricingTierId: "tier-1" }),
      makeParams("test-event"),
    );
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.originalPrice).toBe(300);
    expect(data.discountAmount).toBe(60); // 20% of 300
    expect(data.finalPrice).toBe(240);
  });

  it("allows unlimited uses when maxUses is null", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      maxUses: null,
      usedCount: 9999,
    });
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(true);
  });

  it("allows when per-email limit is null (unlimited)", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      maxUsesPerEmail: null,
    });
    mockDb.promoCodeRedemption.count.mockResolvedValue(50);
    const res = await ValidatePromo(makeRequest(validBody), makeParams("test-event"));
    const data = await res.json();
    expect(data.valid).toBe(true);
  });

  it("applies to all ticket types when ticketTypes array is empty", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue({
      ...samplePromo,
      ticketTypes: [],
    });
    const res = await ValidatePromo(
      makeRequest({ ...validBody, ticketTypeId: "any-ticket" }),
      makeParams("test-event"),
    );
    const data = await res.json();
    expect(data.valid).toBe(true);
  });

  it("case-insensitive code lookup (uppercases input)", async () => {
    mockDb.promoCode.findUnique.mockResolvedValue(samplePromo);
    await ValidatePromo(
      makeRequest({ ...validBody, code: "earlybird20" }),
      makeParams("test-event"),
    );
    expect(mockDb.promoCode.findUnique).toHaveBeenCalledWith({
      where: { eventId_code: { eventId: "evt-1", code: "EARLYBIRD20" } },
      include: expect.any(Object),
    });
  });
});
