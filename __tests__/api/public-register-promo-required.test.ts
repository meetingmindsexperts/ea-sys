/**
 * The promo-code requirement on a registration type (Oct 16, 2026), on the real
 * public register route: a sponsor-only "Inclusive" type is visible on the form
 * but cannot be registered on without a code. Same sentinel approach as
 * supporting-document-gate.test.ts: reaching the transaction means the gate let
 * the registration through; whether the code itself is valid and applies to
 * the type is checked by the existing promo rules inside that transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockTenantTransaction } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
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
vi.mock("@/lib/registration-seat-db", () => ({ claimEventSeats: vi.fn(async () => true) }));
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
    settings: {},
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

describe("promo-code requirement", () => {
  it("refuses a code-required type with no code, before anything is written", async () => {
    const r = await run({ requiresPromoCode: true });
    expect(r).toMatchObject({ status: 400, code: "PROMO_CODE_REQUIRED", reachedTransaction: false });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "public/register:promo-code-required" }));
  });

  it("refuses a blank code the same way", async () => {
    const r = await run({ requiresPromoCode: true }, { promoCode: "   " });
    expect(r).toMatchObject({ status: 400, code: "PROMO_CODE_REQUIRED", reachedTransaction: false });
  });

  it("lets a code-required type through with a code, to the promo checks", async () => {
    const r = await run({ requiresPromoCode: true }, { promoCode: "BIOLOGIX" });
    expect(r.code).not.toBe("PROMO_CODE_REQUIRED");
    expect(r.reachedTransaction).toBe(true);
  });

  it("asks nothing of an ordinary type", async () => {
    const r = await run({ requiresPromoCode: false });
    expect(r.reachedTransaction).toBe(true);
  });
});
