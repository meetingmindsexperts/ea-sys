/**
 * Sponsor links and the no-rate gap on the real public register route
 * (Oct 16, 2026). MM Group runs sponsors through a rate, /register/inclusive,
 * at $0 on every type; ticking that rate as a sponsor link must make a
 * sponsor's code mandatory, and only a code whose sponsor covers the fee may
 * open it. Separately, a request that named no rate used to be charged the
 * type's own price, which events that price by rate leave at 0.
 *
 * Same sentinel as supporting-document-gate.test.ts: reaching the transaction
 * means the gates let the request through. The discount-code case runs the
 * transaction for real, up to the promo check, so the refusal is the route's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockTenantTransaction } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    pricingTier: { findFirst: vi.fn(), findMany: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  // Sentinel: reaching the transaction means the gate ALLOWED the registration.
  // Throwing here keeps the test focused on the gate instead of mocking the
  // whole create path, and gives an unmistakable signal either way.
  mockTenantTransaction: vi.fn(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  }),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb, tenantTransaction: mockTenantTransaction }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/utils", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  generateBarcode: () => "BC123",
}));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 1) }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn() }));
vi.mock("@/lib/webinar-email-sequence", () => ({ sendWebinarConfirmationForRegistration: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: vi.fn() }));
vi.mock("@/lib/registration-seat-db", () => ({ claimEventSeats: vi.fn(async () => true), claimSeats: vi.fn(async () => true) }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: () => ({}) }));

import { POST } from "@/app/api/public/events/[slug]/register/route";

const EVENT_ID = "evt-1";

const params = Promise.resolve({ slug: "my-event" });

/** A minimally-valid body; the schema requires the full public field set. */
function body(extra: Record<string, unknown> = {}) {
  return {
    ticketTypeId: "tt-1",
    title: "DR",
    role: "PHYSICIAN",
    firstName: "Ahmed",
    lastName: "Osman",
    email: "ahmed@hospital.org",
    organization: "Tawam Hospital",
    jobTitle: "Resident",
    phone: "+971500000000",
    city: "Al Ain",
    country: "United Arab Emirates",
    specialty: "Cardiology",
    // Required by the server schema since Sep 21, 2026. The real form always
    // sends it; a fixture that omits it is rejected before the gate under test
    // ever runs, which is the point of the rule.
    agreeTerms: true,
    ...extra,
  };
}

function request(extra: Record<string, unknown> = {}) {
  return new Request("http://t", { method: "POST", body: JSON.stringify(body(extra)) });
}

/** Runs the route and reports what the gate decided. */
async function run(ticketType: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  mockDb.ticketType.findFirst.mockResolvedValue({
    id: "tt-1",
    name: "Resident",
    price: 0,
    currency: "USD",
    quantity: 999999,
    soldCount: 0,
    isFaculty: false,
    requiresApproval: false,
    ...ticketType,
  });
  let status: number | undefined;
  let payload: { code?: string } | undefined;
  let reachedTransaction = false;
  try {
    const res = await POST(request(extra), { params });
    status = res.status;
    payload = await res.json();
  } catch (err) {
    if ((err as Error).message === "__REACHED_TRANSACTION__") reachedTransaction = true;
    else throw err;
  }
  // The route wraps its body in try/catch, so a thrown sentinel surfaces as a
  // 500 rather than propagating — check both signals.
  if (status === 500) reachedTransaction = true;
  return { status, code: payload?.code, reachedTransaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantTransaction.mockImplementation(async () => {
    throw new Error("__REACHED_TRANSACTION__");
  });
  mockDb.event.findFirst.mockResolvedValue({
    id: EVENT_ID,
    slug: "my-event",
    name: "Test Event",
    status: "PUBLISHED",
    eventType: "CONFERENCE",
    organizationId: "org-1",
    // Inclusive is this event's sponsor link (code-required-tiers.ts).
    settings: { codeRequiredTiers: ["inclusive"] },
    maxAttendees: null,
    seatCount: 0,
    startDate: new Date("2026-10-02T04:00:00Z"),
    endDate: new Date("2026-10-03T14:00:00Z"),
    timezone: "Asia/Dubai",
    taxRate: null,
    ticketTypes: [],
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
});

const INCLUSIVE = { id: "tier-inc", name: "Inclusive", price: 0, currency: "USD", quantity: 999999, soldCount: 0, requiresApproval: false, salesStart: null, salesEnd: null };
const EARLY_BIRD = { ...INCLUSIVE, id: "tier-eb", name: "Early Bird", price: 250 };

function onTier(tier: typeof INCLUSIVE | null) {
  mockDb.pricingTier.findFirst.mockResolvedValue(tier);
}

describe("sponsor link (a rate whose link needs a sponsor's code)", () => {
  it("refuses the sponsor link with no code, before anything is written", async () => {
    onTier(INCLUSIVE);
    const r = await run({}, { pricingTierId: "tier-inc" });
    expect(r).toMatchObject({ status: 400, code: "PROMO_CODE_REQUIRED", reachedTransaction: false });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "public/register:sponsor-code-required" }));
  });

  it("lets the sponsor link through with a code, to the promo checks", async () => {
    onTier(INCLUSIVE);
    const r = await run({}, { pricingTierId: "tier-inc", promoCode: "BIOLOGIX" });
    expect(r.reachedTransaction).toBe(true);
  });

  it("asks nothing on an ordinary rate", async () => {
    onTier(EARLY_BIRD);
    const r = await run({}, { pricingTierId: "tier-eb" });
    expect(r.reachedTransaction).toBe(true);
  });

  it("refuses a DISCOUNT code on the sponsor link: only a sponsor-covered code opens it", async () => {
    onTier(INCLUSIVE);
    const tx = {
      registration: { findFirst: vi.fn(async () => null) },
      attendee: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "att-1" })) },
      promoCode: {
        findUnique: vi.fn(async () => ({
          id: "p1", code: "ABHLS26", isActive: true, validFrom: null, validUntil: null,
          discountType: "PERCENTAGE", discountValue: 20, maxUses: 60, maxUsesPerEmail: null,
          sponsorId: null, sponsorCoversFee: false, sponsor: null, ticketTypes: [],
        })),
      },
      $queryRaw: vi.fn(async () => []),
    };
    (mockTenantTransaction as unknown as { mockImplementation: (f: (fn: (t: unknown) => unknown) => unknown) => void }).mockImplementation(async (fn) => fn(tx));
    const res = await POST(request({ pricingTierId: "tier-inc", promoCode: "ABHLS26" }), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "PROMO_CODE_NOT_SPONSOR" });
  });
});

describe("no rate named on a type that has rates (security fix)", () => {
  it("refuses instead of charging the type's own price", async () => {
    onTier(null);
    mockDb.pricingTier.findMany.mockResolvedValue([{ name: "Early Bird" }, { name: "Inclusive" }]);
    const r = await run({ price: 0 });
    expect(r).toMatchObject({ status: 400, code: "PRICING_TIER_REQUIRED", reachedTransaction: false });
  });

  it("still serves a type with no rates at its own price", async () => {
    onTier(null);
    mockDb.pricingTier.findMany.mockResolvedValue([]);
    const r = await run({ price: 0 });
    expect(r.reachedTransaction).toBe(true);
  });

  it("does not count presenter rates, which are not public", async () => {
    onTier(null);
    mockDb.pricingTier.findMany.mockResolvedValue([{ name: "Presenter Early Bird" }]);
    const r = await run({ price: 0 });
    expect(r.reachedTransaction).toBe(true);
  });
});
