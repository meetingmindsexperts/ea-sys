/**
 * POST /api/public/events/[slug]/complete-registration — the type-selection
 * path (registrations imported WITHOUT a registration type state it on the
 * completion form; the price/tier is resolved server-side).
 *
 * Pins the two review fixes on top of the base behavior:
 *   M1 — an EXPLICITLY-set paymentStatus (CSV `paymentStatus` column / admin
 *        detail sheet: PAID, INCLUSIVE, …) survives the type-set; only the
 *        typeless COMPLIMENTARY default is recomputed. Without this, someone
 *        who paid offline was flipped back to UNASSIGNED and dunned again.
 *   M3 — the registration-row write is a CONDITIONAL CLAIM
 *        (`where: { id, ticketTypeId: null }`): an organizer assigning a type
 *        concurrently wins; the completion loses with 409
 *        REGISTRATION_TYPE_ALREADY_SET and the whole tx (incl. the seat
 *        increment) rolls back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTokenFindUnique, mockTokenDelete, mockRegFindFirst, mockTtFindFirst,
  mockTransaction, mockTxTtUpdateMany, mockTxRegUpdateMany, mockTxAttendeeUpdate,
  mockTxTokenDelete, mockTxAuditCreate,
} = vi.hoisted(() => ({
  mockTokenFindUnique: vi.fn(),
  mockTokenDelete: vi.fn(),
  mockRegFindFirst: vi.fn(),
  mockTtFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxTtUpdateMany: vi.fn(),
  mockTxRegUpdateMany: vi.fn(),
  mockTxAttendeeUpdate: vi.fn(),
  mockTxTokenDelete: vi.fn(),
  mockTxAuditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    verificationToken: { findUnique: mockTokenFindUnique, delete: mockTokenDelete },
    registration: { findFirst: mockRegFindFirst },
    ticketType: { findFirst: mockTtFindFirst },
    $transaction: mockTransaction,
  },
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated site.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockTransaction(fn),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "1.2.3.4"),
  hashVerificationToken: vi.fn((t: string) => `hashed:${t}`),
}));
vi.mock("@/lib/public-event", () => ({
  eventMatchesRequestTenant: vi.fn(async () => true),
}));
vi.mock("@/lib/api-errors", () => ({
  rateLimited: vi.fn(),
}));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: vi.fn() }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: vi.fn(() => ({})) }));

import { POST } from "@/app/api/public/events/[slug]/complete-registration/route";

const SLUG = "my-event";

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    token: "tok1",
    title: "DR",
    role: "PHYSICIAN",
    jobTitle: "Consultant",
    organization: "City Hospital",
    phone: "+971500000000",
    city: "Dubai",
    country: "United Arab Emirates",
    specialty: "Cardiology",
    agreeTerms: true,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/public/events/${SLUG}/complete-registration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const makeParams = () => ({ params: Promise.resolve({ slug: SLUG }) });

/** A typeless imported registration awaiting completion. */
function makeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg-1",
    serialId: 7,
    status: "CONFIRMED",
    userId: null,
    attendeeId: "att-1",
    taxNumber: null,
    billingFirstName: null, billingLastName: null, billingEmail: null,
    billingPhone: null, billingAddress: null, billingCity: null,
    billingState: null, billingZipCode: null, billingCountry: null,
    attendee: {
      email: "person@example.com", additionalEmail: null,
      firstName: "Pat", lastName: "Lee", title: null,
      organization: null, jobTitle: null, phone: null, city: null, country: null,
      specialty: null, registrationType: null,
      associationName: null, memberId: null, studentId: null, studentIdExpiry: null,
    },
    event: {
      id: "evt-1", name: "Cardio Summit", slug: SLUG,
      startDate: new Date("2027-03-01T09:00:00Z"),
      venue: "Expo", city: "Dubai", country: "UAE", organizationId: "org-1",
      taxRate: null, taxLabel: null, bankDetails: null, supportEmail: null,
      organization: {
        name: "MMG", logo: null,
        companyName: null, companyAddress: null, companyCity: null,
        companyState: null, companyZipCode: null, companyCountry: null, taxId: null,
      },
    },
    ticketTypeId: null,
    paymentStatus: "COMPLIMENTARY", // the typeless-import default
    ticketType: null,
    pricingTier: null,
    ...overrides,
  };
}

function makeChosenType(overrides: Record<string, unknown> = {}) {
  return {
    id: "tt-1", name: "Physician", description: null,
    price: "100", currency: "USD", quantity: 100, soldCount: 3,
    requiresApproval: false,
    pricingTiers: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenFindUnique.mockResolvedValue({
    identifier: "reg:reg-1",
    token: "hashed:tok1",
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  mockRegFindFirst.mockResolvedValue(makeRegistration());
  mockTtFindFirst.mockResolvedValue(makeChosenType());
  // Happy-path tx: run the callback against the tx mock.
  mockTxTtUpdateMany.mockResolvedValue({ count: 1 });
  mockTxRegUpdateMany.mockResolvedValue({ count: 1 });
  mockTxAttendeeUpdate.mockResolvedValue({});
  mockTxTokenDelete.mockResolvedValue({});
  mockTxAuditCreate.mockResolvedValue({});
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      ticketType: { updateMany: mockTxTtUpdateMany },
      registration: { updateMany: mockTxRegUpdateMany },
      attendee: { update: mockTxAttendeeUpdate },
      verificationToken: { delete: mockTxTokenDelete },
      auditLog: { create: mockTxAuditCreate },
    }),
  );
});

describe("completion type-set — base behavior", () => {
  it("400s REGISTRATION_TYPE_REQUIRED when typeless and no type was chosen", async () => {
    const res = await POST(makeRequest(makeBody()), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "REGISTRATION_TYPE_REQUIRED" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("400s INVALID_REGISTRATION_TYPE when the chosen id doesn't resolve (wrong event / faculty / inactive)", async () => {
    mockTtFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-evil" })), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REGISTRATION_TYPE" });
    // The lookup is bound to the event + publicly-selectable + non-faculty.
    expect(mockTtFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "tt-evil", eventId: "evt-1", isActive: true, isFaculty: false,
        }),
      }),
    );
  });

  it("sets the type, claims the seat, stamps the tier price, and flips the default to UNASSIGNED", async () => {
    mockTtFindFirst.mockResolvedValue(
      makeChosenType({
        pricingTiers: [{
          id: "tier-eb", name: "Early Bird", price: "80", currency: "USD",
          quantity: 50, soldCount: 0, isActive: true,
          salesStart: null, salesEnd: null, sortOrder: 0,
        }],
      }),
    );
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    const json = await res.json();
    // The response prices the completion at the OPEN tier, not the base price.
    expect(json.registration).toMatchObject({ ticketPrice: 80, ticketCurrency: "USD" });

    expect(mockTxTtUpdateMany).toHaveBeenCalledWith({
      where: { id: "tt-1", soldCount: { lt: 100 } },
      data: { soldCount: { increment: 1 } },
    });
    expect(mockTxRegUpdateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", ticketTypeId: null }, // M3: conditional claim
      data: expect.objectContaining({
        ticketTypeId: "tt-1",
        pricingTierId: "tier-eb",
        originalPrice: 80,
        paymentStatus: "UNASSIGNED", // default was COMPLIMENTARY → now payable
      }),
    });
  });

  it("409s REGISTRATION_TYPE_SOLD_OUT and rolls back when the seat claim loses", async () => {
    mockTxTtUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REGISTRATION_TYPE_SOLD_OUT" });
    // The token was never consumed — they can pick again.
    expect(mockTxTokenDelete).not.toHaveBeenCalled();
  });
});

describe("M1 — explicitly-set paymentStatus survives the type-set", () => {
  it("does NOT touch paymentStatus when the row was imported/marked PAID (offline payment)", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ paymentStatus: "PAID" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);

    const data = mockTxRegUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("paymentStatus"); // PAID survives — no re-dunning
    expect(data).toMatchObject({ ticketTypeId: "tt-1", originalPrice: 100 });

    // …and the audit trail records WHICH status survived.
    const changes = mockTxAuditCreate.mock.calls[0][0].data.changes;
    expect(changes).toMatchObject({ paymentStatusPreserved: "PAID" });
  });

  it("does NOT touch paymentStatus for a sponsor-paid INCLUSIVE row", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ paymentStatus: "INCLUSIVE" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).not.toHaveProperty("paymentStatus");
  });

  it("keeps the COMPLIMENTARY default when the chosen type is free", async () => {
    mockTtFindFirst.mockResolvedValue(makeChosenType({ price: "0" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).toMatchObject({
      paymentStatus: "COMPLIMENTARY",
      originalPrice: 0,
    });
  });
});

describe("L2 — a self-selected requiresApproval type enters the approval queue", () => {
  it("flips the import-default CONFIRMED to PENDING and reflects it in the response + audit", async () => {
    mockTtFindFirst.mockResolvedValue(makeChosenType({ requiresApproval: true, name: "Student" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);

    expect(mockTxRegUpdateMany.mock.calls[0][0].data).toMatchObject({ status: "PENDING" });
    // The response reflects the flip (the loaded row predates it).
    expect((await res.json()).registration.status).toBe("PENDING");
    expect(mockTxAuditCreate.mock.calls[0][0].data.changes).toMatchObject({
      statusFlippedToPending: true,
    });
  });

  it("does NOT flip an explicitly imported non-CONFIRMED status (e.g. CHECKED_IN)", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ status: "CHECKED_IN" }));
    mockTtFindFirst.mockResolvedValue(makeChosenType({ requiresApproval: true }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).not.toHaveProperty("status");
  });

  it("leaves status untouched for a normal (no-approval) type", async () => {
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).not.toHaveProperty("status");
    expect((await res.json()).registration.status).toBe("CONFIRMED");
  });
});

describe("M3 — losing the type-set race to a concurrent organizer assignment", () => {
  it("409s REGISTRATION_TYPE_ALREADY_SET when the conditional row claim matches nothing", async () => {
    mockTxRegUpdateMany.mockResolvedValue({ count: 0 }); // organizer got there first
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REGISTRATION_TYPE_ALREADY_SET" });
    // Thrown inside the tx: the attendee update + token delete never ran, and
    // the seat increment above rolls back with the transaction.
    expect(mockTxAttendeeUpdate).not.toHaveBeenCalled();
    expect(mockTxTokenDelete).not.toHaveBeenCalled();
  });
});

describe("already-typed registrations are untouched by the type machinery", () => {
  it("completes without any registration write and ignores a smuggled ticketTypeId", async () => {
    mockRegFindFirst.mockResolvedValue(
      makeRegistration({
        ticketTypeId: "tt-existing",
        paymentStatus: "UNPAID",
        ticketType: { id: "tt-existing", name: "Nurse", price: "50", currency: "USD" },
      }),
    );
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    // No type resolution, no seat claim, no registration row write.
    expect(mockTtFindFirst).not.toHaveBeenCalled();
    expect(mockTxTtUpdateMany).not.toHaveBeenCalled();
    expect(mockTxRegUpdateMany).not.toHaveBeenCalled();
    expect((await res.json()).registration).toMatchObject({ ticketPrice: 50 });
  });
});
