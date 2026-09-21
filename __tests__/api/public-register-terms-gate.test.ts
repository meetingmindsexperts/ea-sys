/**
 * The SERVER-SIDE terms-consent gate on the public register route.
 *
 * WHY THIS EXISTS (Sep 21, 2026 security review, finding #2).
 *
 * The "I agree to the terms and conditions" tick-box was enforced ONLY in the
 * browser: the client schema had `agreeTerms: z.literal(true)`, the client did
 * send the field, and the server's Zod schema did not declare it — so Zod's
 * default strip silently discarded it.
 *
 * That alone would be a correctness wart. What made it matter is that the same
 * request then wrote a consent RECORD it had never verified —
 * `ensureRegistrantAccount` sets `termsAcceptedAt` + `termsAcceptedIp`
 * unconditionally. So a POST straight to this endpoint (curl, a bot, a stale
 * JS bundle) registered successfully AND was recorded as having accepted the
 * terms, which makes the stored timestamp and IP worthless as evidence in a
 * refund dispute: the code writes them either way.
 *
 * The distinction this file pins is between a LOG and EVIDENCE. A log records
 * that something happened; evidence must be something that could only have
 * been written if the thing actually happened. These cases keep it the second.
 *
 * MUTATION CHECK: delete the `agreeTerms` line from the route's
 * `registrationSchema` and the first three cases fail. The last case is the
 * counterweight — it fails if someone "fixes" a future break by making the
 * field optional, which would silently restore the original hole.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockTenantTransaction } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  // Sentinel: reaching the transaction means the schema ACCEPTED the body.
  // Throwing keeps the test on the gate instead of mocking the create path.
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

/**
 * The full public field set the schema requires, minus `agreeTerms` — each
 * case supplies (or withholds) that one field, so nothing else can be the
 * reason a body is refused.
 */
function bodyWithout(extra: Record<string, unknown> = {}) {
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
    ...extra,
  };
}

async function post(extra: Record<string, unknown> = {}) {
  const req = new Request("http://t", {
    method: "POST",
    body: JSON.stringify(bodyWithout(extra)),
  });
  const res = await POST(req, { params });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();

  mockDb.event.findFirst.mockResolvedValue({
    id: EVENT_ID,
    name: "Test Event",
    slug: "my-event",
    status: "PUBLISHED",
    eventType: "CONFERENCE",
    settings: {},
    organizationId: "org-1",
    maxAttendees: null,
    seatCount: 0,
    taxRate: null,
    taxLabel: null,
    organization: { name: "MMG" },
  });
  mockDb.ticketType.findFirst.mockResolvedValue({
    id: "tt-1",
    name: "Physician",
    price: 0,
    currency: "USD",
    quantity: 1000,
    soldCount: 0,
    isActive: true,
    isFaculty: false,
    requiresApproval: false,
    salesStartDate: null,
    salesEndDate: null,
    requiresDocument: false,
    documentRequired: false,
    requiresMemberId: false,
    requiresStudentId: false,
    requiresStudentIdExpiry: false,
    pricingTiers: [],
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
});

describe("public register — terms consent is enforced server-side", () => {
  it("refuses a body that omits agreeTerms entirely (the crafted-POST case)", async () => {
    const { status, body } = await post();

    expect(status).toBe(400);
    expect(body.error).toBe("Invalid input");
    // Never reached the create path, so no consent record could be written.
    expect(mockTenantTransaction).not.toHaveBeenCalled();
  });

  it("refuses agreeTerms: false — an explicit refusal is not consent", async () => {
    const { status } = await post({ agreeTerms: false });

    expect(status).toBe(400);
    expect(mockTenantTransaction).not.toHaveBeenCalled();
  });

  it("refuses a truthy non-true value — z.literal(true), not a truthiness check", async () => {
    // The shape a hand-rolled `if (!agreeTerms)` guard would have let through.
    const { status } = await post({ agreeTerms: "yes" });

    expect(status).toBe(400);
    expect(mockTenantTransaction).not.toHaveBeenCalled();
  });

  it("logs the refusal rather than failing silently", async () => {
    await post();

    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "public/events/register:zod-validation-failed",
      })
    );
  });

  it("accepts agreeTerms: true and proceeds to the create path", async () => {
    // The counterweight case. If this ever fails, the field was made optional
    // or the client contract changed — do NOT fix it by relaxing the rule.
    //
    // Asserting the sentinel was REACHED rather than that it propagated: the
    // route wraps everything in a try/catch, so the throw surfaces as a 500.
    // Whether the transaction was entered is the real signal, and it is the
    // one that distinguishes "schema accepted the body" from "schema refused
    // it" — a 400 never gets this far.
    const { status } = await post({ agreeTerms: true });

    expect(mockTenantTransaction).toHaveBeenCalled();
    expect(status).not.toBe(400);
  });
});
