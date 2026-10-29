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

/** Writes to the registration that touch its type, rate, price or payment: everything but the completion
 *  stamp (completedAt, the document, tax and billing), which every successful completion writes. */
function typeOrPriceWrites(mock: { mock: { calls: unknown[][] } }): unknown[] {
  const STAMP = new Set(["completedAt", "supportingDocumentUrl", "supportingDocumentFilename", "taxNumber",
    "billingFirstName", "billingLastName", "billingEmail", "billingPhone", "billingAddress", "billingCity",
    "billingState", "billingZipCode", "billingCountry"]);
  return mock.mock.calls.filter((c) => Object.keys((c[0] as { data: object }).data).some((k) => !STAMP.has(k)));
}

const {
  mockTokenFindUnique, mockTokenDelete, mockRegFindFirst, mockTtFindFirst, mockTtFindMany,
  mockTransaction, mockTxTtUpdateMany, mockTxRegUpdateMany, mockTxAttendeeUpdate,
  mockTxTokenDelete, mockTxAuditCreate, mockTxExecuteRaw,
} = vi.hoisted(() => ({
  mockTxExecuteRaw: vi.fn(),
  mockTokenFindUnique: vi.fn(),
  mockTokenDelete: vi.fn(),
  mockRegFindFirst: vi.fn(),
  mockTtFindFirst: vi.fn(),
  mockTtFindMany: vi.fn(),
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
    ticketType: { findFirst: mockTtFindFirst, findMany: mockTtFindMany },
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

import { GET, POST } from "@/app/api/public/events/[slug]/complete-registration/route";

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
    attendanceMode: "IN_PERSON",
    createdSource: "CSV_IMPORT",
    qrCode: "QR-EXISTING", // already has its entry barcode, so none is minted
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
    // A typeless payer. A typeless COMPLIMENTARY row (the import default) completes
    // free instead (rateFromRegistration, complete-registration-link-rate.test.ts).
    paymentStatus: "UNASSIGNED",
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
  mockTxExecuteRaw.mockResolvedValue(1); // the event-seat claim fits
  mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      $executeRaw: mockTxExecuteRaw,
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

  it("sets the type, claims the seat, stamps the tier price, and leaves an owing status as it is", async () => {
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
      where: { id: "reg-1", ticketTypeId: null, status: { not: "CANCELLED" } }, // M3: conditional claim, never a cancelled row
      data: expect.objectContaining({
        ticketTypeId: "tt-1",
        pricingTierId: "tier-eb",
        originalPrice: 80,
      }),
    });
    // Already payable: the status is left as it is.
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).not.toHaveProperty("paymentStatus");
  });

  it("its first type also claims its event seat; a full event refuses (Oct 29, 2026)", async () => {
    mockTtFindFirst.mockResolvedValue(makeChosenType());
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    const eventClaims = mockTxExecuteRaw.mock.calls.filter((c) => (c[0] as string[]).join("?").includes('"Event"'));
    expect(eventClaims).toHaveLength(1);

    mockTxExecuteRaw.mockResolvedValue(0); // event full
    mockTxTokenDelete.mockClear();
    const full = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(full.status).toBe(409);
    // Its own code: no other type would fit either (review of a10e8058, L5).
    expect((await full.json()).code).toBe("EVENT_FULL");
    // The transaction threw, so the row claim rolls back and the token survives.
    expect(mockTxTokenDelete).not.toHaveBeenCalled();
  });

  it("a virtual attendee picking a type claims no seat on it, and no event seat", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ attendanceMode: "VIRTUAL" }));
    mockTtFindFirst.mockResolvedValue(makeChosenType());
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxTtUpdateMany).not.toHaveBeenCalled();
    expect(mockTxExecuteRaw.mock.calls.filter((c) => (c[0] as string[]).join("?").includes('"Event"'))).toHaveLength(0);
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

  // A typeless COMPLIMENTARY row completes free on a priced type, through the
  // link-rate path: complete-registration-link-rate.test.ts, "a link without a rate".

  it("a typeless COMPLIMENTARY row the link may not reprice (a promo code) takes the open rate and becomes payable", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({
      paymentStatus: "COMPLIMENTARY", promoCodeId: "promo-1", refundedAmount: 0, _count: { payments: 0, invoices: 0 },
    }));
    mockTtFindFirst.mockResolvedValue(makeChosenType());
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    expect(mockTxRegUpdateMany.mock.calls[0][0].data).toMatchObject({ originalPrice: 100, paymentStatus: "UNASSIGNED" });
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
    expect(typeOrPriceWrites(mockTxRegUpdateMany)).toEqual([]);
    expect((await res.json()).registration).toMatchObject({ ticketPrice: 50 });
  });
});

/**
 * Identity evidence, enforced SERVER-side (Sept 2, 2026).
 *
 * Until now this route validated only that a SUPPLIED expiry parsed as a date.
 * The requirement itself lived in the browser, which means it was one crafted
 * request away from being skipped entirely — and the completion link is public,
 * token-gated, and handed to people by email.
 *
 * The switches also replace a NAME MATCH. The tests that matter are the two
 * that state what the name match got wrong: a type CALLED "Student" with the
 * switch off must not demand anything, and a type called anything at all with
 * the switch on must.
 */
describe("completion — identity evidence", () => {
  const asks = (o: Record<string, unknown> = {}) =>
    makeChosenType({
      requiresMemberId: false,
      requiresStudentId: true,
      requiresStudentIdExpiry: true,
      ...o,
    });

  it("refuses when the chosen type asks for a student ID and none was given", async () => {
    mockTtFindFirst.mockResolvedValue(asks());
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "IDENTITY_EVIDENCE_REQUIRED",
      missing: ["Student ID", "Student ID expiry date"],
    });
    // Refused BEFORE the write, so no seat is claimed and no type is set.
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("proceeds once the asked-for values are supplied", async () => {
    mockTtFindFirst.mockResolvedValue(asks());
    const res = await POST(
      makeRequest(makeBody({ ticketTypeId: "tt-1", studentId: "STU-1", studentIdExpiry: "2028-01-31" })),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalled();
  });

  it("a type NAMED Student with the switch off demands nothing", async () => {
    // The regression that proves the name match is gone. Before this, the name
    // alone made these fields mandatory; now only the switch does.
    mockTtFindFirst.mockResolvedValue(
      makeChosenType({ name: "Student", requiresStudentId: false, requiresMemberId: false }),
    );
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
  });

  it("a type named Resident CAN now ask — the old patterns never matched it", async () => {
    // "Resident" is the most-registered type in this family, on 19 events, and
    // matched neither /member/ nor /student/, so it asked for nothing at all.
    mockTtFindFirst.mockResolvedValue(asks({ name: "Resident" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDENTITY_EVIDENCE_REQUIRED" });
  });

  it("does not demand the expiry when only the ID is switched on", async () => {
    mockTtFindFirst.mockResolvedValue(asks({ requiresStudentIdExpiry: false }));
    const res = await POST(
      makeRequest(makeBody({ ticketTypeId: "tt-1", studentId: "STU-1" })),
      makeParams(),
    );
    expect(res.status).toBe(200);
  });

  it("reads the policy off the STORED type when the registration already has one", async () => {
    // The other branch: nothing is being chosen, so the rule has to come from
    // the type already on the row.
    mockRegFindFirst.mockResolvedValue(
      makeRegistration({
        ticketTypeId: "tt-9",
        ticketType: {
          id: "tt-9", name: "Anything", price: "100", currency: "USD",
          requiresMemberId: true, requiresStudentId: false, requiresStudentIdExpiry: false,
        },
      }),
    );
    const res = await POST(makeRequest(makeBody()), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ missing: ["Member ID"] });
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("completion never prices on a sponsor-link or presenter rate (Oct 16, 2026)", () => {
  const withSponsorLinks = (codeRequiredTiers: string[]) => {
    const reg = makeRegistration();
    return { ...reg, event: { ...reg.event, settings: { codeRequiredTiers } } };
  };
  const rate = (over: Record<string, unknown>) => ({
    id: "tier-x", name: "Early Bird", price: "80", currency: "USD",
    quantity: 50, soldCount: 0, isActive: true,
    salesStart: null, salesEnd: null, sortOrder: 0, ...over,
  });

  it("skips the $0 sponsor-link rate even when it sorts first, and prices on the open public rate", async () => {
    mockRegFindFirst.mockResolvedValue(withSponsorLinks(["inclusive"]));
    mockTtFindFirst.mockResolvedValue(makeChosenType({
      pricingTiers: [
        rate({ id: "tier-inc", name: "Inclusive", price: "0", sortOrder: 0 }),
        rate({ id: "tier-eb", name: "Early Bird", price: "80", sortOrder: 1 }),
      ],
    }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(200);
    const data = mockTxRegUpdateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ pricingTierId: "tier-eb" });
  });

  it("400s NO_RATE_ON_SALE when only sponsor-link and presenter rates are open, and writes nothing", async () => {
    mockRegFindFirst.mockResolvedValue(withSponsorLinks(["Inclusive"]));
    mockTtFindFirst.mockResolvedValue(makeChosenType({
      price: "0",
      pricingTiers: [
        rate({ id: "tier-inc", name: "Inclusive", price: "0" }),
        rate({ id: "tier-pres", name: "Presenter", price: "0", sortOrder: 1 }),
        rate({ id: "tier-eb", name: "Early Bird", isActive: false, sortOrder: 2 }),
      ],
    }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "NO_RATE_ON_SALE" });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("the GET lists a type whose only open rate is a sponsor link as unavailable, and never returns the settings", async () => {
    mockRegFindFirst.mockResolvedValue(withSponsorLinks(["inclusive"]));
    mockTtFindMany.mockResolvedValue([
      makeChosenType({ price: "0", pricingTiers: [rate({ id: "tier-inc", name: "Inclusive", price: "0" })] }),
    ]);
    const res = await GET(new Request(`http://localhost/api/public/events/${SLUG}/complete-registration?token=tok1`), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.event).not.toHaveProperty("settings");
    expect(body.selectableTicketTypes[0]).toMatchObject({ id: "tt-1", available: false });
  });
});

describe("the completion form captures what the public form does (docs/ONSITE_DESK_PLAN.md §3.3)", () => {
  const stamp = () =>
    mockTxRegUpdateMany.mock.calls.map((c) => c[0] as { data: Record<string, unknown> }).find((c) => "completedAt" in c.data)?.data;

  it("stamps completedAt, and saves the tax and billing details and the second email", async () => {
    const res = await POST(
      makeRequest(makeBody({
        ticketTypeId: "tt-1",
        additionalEmail: "pat.alt@example.com",
        billingSame: false,
        taxNumber: "AE123",
        billingFirstName: "Pat", billingLastName: "Lee", billingEmail: "billing@hospital.ae", billingPhone: "+971500",
        billingAddress: "1 Main St", billingCity: "Dubai", billingState: "Dubai", billingZipCode: "000", billingCountry: "UAE",
      })),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(stamp()).toMatchObject({
      completedAt: expect.any(Date),
      taxNumber: "AE123",
      billingEmail: "billing@hospital.ae",
      billingCountry: "UAE",
    });
    expect(mockTxAttendeeUpdate.mock.calls[0][0].data).toMatchObject({ additionalEmail: "pat.alt@example.com" });
  });

  it("billing \"same as personal details\" fills only empty columns: the organiser's company billing stays (review MED)", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ billingFirstName: "Acme", billingAddress: "1 Corporate Rd" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1", billingSame: true })), makeParams());
    expect(res.status).toBe(200);
    const data = stamp()!;
    expect(data).not.toHaveProperty("billingFirstName");
    expect(data).not.toHaveProperty("billingAddress");
    expect(data).toMatchObject({ billingLastName: "Lee", billingEmail: "person@example.com" });
  });

  it("requires the supporting document when the type requires one", async () => {
    mockTtFindFirst.mockResolvedValue(makeChosenType({ requiresDocument: true, documentRequired: true, documentLabel: "Resident letter" }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "SUPPORTING_DOCUMENT_REQUIRED", error: "Resident letter is required for this registration type." });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("keeps a document uploaded for this event, and drops one pointing at another event", async () => {
    mockTtFindFirst.mockResolvedValue(makeChosenType({ requiresDocument: true, documentRequired: false }));
    let res = await POST(makeRequest(makeBody({
      ticketTypeId: "tt-1",
      supportingDocumentUrl: "/uploads/resident-letters/evt-1/0b1c2d3e-aaaa-bbbb-cccc-123456789abc.pdf",
      supportingDocumentFilename: "letter.pdf",
    })), makeParams());
    expect(res.status).toBe(200);
    expect(stamp()).toMatchObject({ supportingDocumentUrl: "/uploads/resident-letters/evt-1/0b1c2d3e-aaaa-bbbb-cccc-123456789abc.pdf", supportingDocumentFilename: "letter.pdf" });

    vi.clearAllMocks();
    mockTokenFindUnique.mockResolvedValue({ identifier: "reg:reg-1", token: "hashed:tok1", expires: new Date(Date.now() + 86_400_000) });
    mockRegFindFirst.mockResolvedValue(makeRegistration());
    mockTtFindFirst.mockResolvedValue(makeChosenType({ requiresDocument: true, documentRequired: false }));
    mockTxRegUpdateMany.mockResolvedValue({ count: 1 });
    res = await POST(makeRequest(makeBody({
      ticketTypeId: "tt-1",
      supportingDocumentUrl: "/uploads/resident-letters/evt-OTHER/0b1c2d3e-aaaa-bbbb-cccc-123456789abc.pdf",
    })), makeParams());
    expect(res.status).toBe(200);
    expect(stamp()).not.toHaveProperty("supportingDocumentUrl");
  });

  it("refuses a registration already completed without an account (completedAt set)", async () => {
    mockRegFindFirst.mockResolvedValue(makeRegistration({ completedAt: new Date("2026-10-01T00:00:00Z") }));
    const res = await POST(makeRequest(makeBody({ ticketTypeId: "tt-1" })), makeParams());
    expect(res.status).toBe(409);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
