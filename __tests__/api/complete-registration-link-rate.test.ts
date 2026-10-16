/**
 * The completion form for a link that carries a rate
 * (docs/REGISTRATION_FORM_LINKS_PLAN.md, owner D3 and D5):
 *  - the types offered are those with the rate on sale, priced at it, and the
 *    person's own type stays offered even when full;
 *  - a closed rate is refused, never swapped for another;
 *  - keeping, setting or changing the type prices at the link's rate, and the
 *    seat follows through the shared transition;
 *  - a status already holding money is never touched;
 *  - older `reg:` links behave as before (covered by the type-select tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, tx, transitionMock, confirmationMock } = vi.hoisted(() => {
  const tx = {
    registration: { updateMany: vi.fn() },
    ticketType: { updateMany: vi.fn() },
    attendee: { update: vi.fn() },
    verificationToken: { delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    transitionMock: vi.fn(),
    confirmationMock: vi.fn(),
    mockDb: {
      verificationToken: { findUnique: vi.fn(), delete: vi.fn() },
      registration: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn(), findMany: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (t: typeof tx) => unknown) => fn(tx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "1.2.3.4"),
  hashVerificationToken: vi.fn((t: string) => `hashed:${t}`),
}));
vi.mock("@/lib/public-event", () => ({ eventMatchesRequestTenant: vi.fn(async () => true) }));
vi.mock("@/lib/api-errors", () => ({ rateLimited: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: confirmationMock }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registrant-account", () => ({ ensureRegistrantAccount: vi.fn() }));
vi.mock("@/lib/registration-confirmation", () => ({ buildEventConfirmationFields: vi.fn(() => ({})) }));
vi.mock("@/lib/registration-seat-db", () => ({ applyRegistrationTransition: transitionMock }));

import { GET, POST } from "@/app/api/public/events/[slug]/complete-registration/route";

const SLUG = "BHS2026";
const DAY = 86_400_000;
const params = () => ({ params: Promise.resolve({ slug: SLUG }) });

const rate = (over: Record<string, unknown> = {}) => ({
  id: "t-eb", name: "Early Bird", price: "250", currency: "USD", quantity: 999999, soldCount: 0,
  isActive: true, salesStart: null, salesEnd: new Date(Date.now() + 10 * DAY), sortOrder: 0, ...over,
});
const type = (over: Record<string, unknown> = {}) => ({
  id: "tt-phys", name: "Physician", description: null, price: "0", currency: "USD",
  quantity: 100, soldCount: 3, requiresApproval: false,
  requiresMemberId: false, requiresStudentId: false, requiresStudentIdExpiry: false,
  pricingTiers: [rate()],
  ...over,
});
const PHYS = type();
const NURSE = type({ id: "tt-nurse", name: "Nurse", pricingTiers: [rate({ id: "t-n-eb", price: "150" })] });
const EXH = type({ id: "tt-exh", name: "Exhibitor", pricingTiers: [rate({ id: "t-inc", name: "Inclusive", price: "0" })] });

function registration(over: Record<string, unknown> = {}) {
  return {
    id: "reg-1", serialId: 7, status: "CONFIRMED", userId: null, attendeeId: "att-1", taxNumber: null,
    billingFirstName: null, billingLastName: null, billingEmail: null, billingPhone: null, billingAddress: null,
    billingCity: null, billingState: null, billingZipCode: null, billingCountry: null,
    attendee: {
      email: "pat@example.com", additionalEmail: null, firstName: "Pat", lastName: "Lee", title: null,
      organization: null, jobTitle: null, phone: null, city: null, country: null, specialty: null,
      registrationType: "Physician", associationName: null, memberId: null, studentId: null, studentIdExpiry: null,
    },
    event: {
      id: "evt-1", name: "BHS", slug: SLUG, startDate: new Date("2027-03-01"), venue: "X", city: "Dubai",
      country: "UAE", organizationId: "org-1", taxRate: null, taxLabel: null, bankDetails: null,
      supportEmail: null, settings: { codeRequiredTiers: ["inclusive"] },
      organization: { name: "MMG", logo: null, companyName: null, companyAddress: null, companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, taxId: null },
    },
    ticketTypeId: "tt-phys",
    paymentStatus: "UNASSIGNED",
    attendanceMode: "IN_PERSON",
    createdSource: "CSV_IMPORT",
    pricingTierId: "t-eb",
    sponsorId: null,
    ticketType: { id: "tt-phys", name: "Physician", price: "0", currency: "USD", requiresMemberId: false, requiresStudentId: false, requiresStudentIdExpiry: false },
    pricingTier: { id: "t-eb", name: "Early Bird", price: "250", currency: "USD" },
    ...over,
  };
}

function token(identifier = "regform:reg-1:early-bird") {
  mockDb.verificationToken.findUnique.mockResolvedValue({ identifier, token: "hashed:tok", expires: new Date(Date.now() + DAY) });
}

const body = (over: Record<string, unknown> = {}) => ({
  token: "tok", title: "DR", role: "PHYSICIAN", jobTitle: "Consultant", organization: "Clinic",
  phone: "+971500000000", city: "Dubai", country: "United Arab Emirates", specialty: "Cardiology",
  agreeTerms: true, ...over,
});
const post = (over: Record<string, unknown> = {}) =>
  POST(new Request(`http://localhost/api/public/events/${SLUG}/complete-registration`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(over)),
  }), params());
const get = () => GET(new Request(`http://localhost/api/public/events/${SLUG}/complete-registration?token=tok`), params());
const rowWrite = () => tx.registration.updateMany.mock.calls[0]?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  token();
  mockDb.registration.findFirst.mockResolvedValue(registration());
  mockDb.ticketType.findFirst.mockResolvedValue(PHYS);
  mockDb.ticketType.findMany.mockResolvedValue([PHYS, NURSE, EXH]);
  tx.registration.updateMany.mockResolvedValue({ count: 1 });
  tx.attendee.update.mockResolvedValue({});
  tx.verificationToken.delete.mockResolvedValue({});
  tx.auditLog.create.mockResolvedValue({});
  transitionMock.mockResolvedValue(undefined);
  confirmationMock.mockResolvedValue(undefined);
});

describe("GET with a rated link", () => {
  it("offers the types with the rate on sale, priced at it, and never the settings", async () => {
    const res = await get();
    const json = await res.json();
    expect(json.linkRate).toEqual({ name: "Early Bird", closed: false });
    expect(json.selectableTicketTypes.map((t: { id: string; price: number }) => [t.id, t.price])).toEqual([["tt-phys", 250], ["tt-nurse", 150]]);
    expect(json.event).not.toHaveProperty("settings");
  });

  it("keeps the person's own type offered even when it is full", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([type({ soldCount: 100 }), NURSE]);
    const json = await (await get()).json();
    expect(json.selectableTicketTypes[0]).toMatchObject({ id: "tt-phys", available: true });
  });

  it("says the rate has closed when it is on sale on no type", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([type({ pricingTiers: [rate({ salesEnd: new Date(Date.now() - DAY) })] })]);
    const json = await (await get()).json();
    expect(json.linkRate).toEqual({ name: "Early Bird", closed: true });
    expect(json.selectableTicketTypes).toEqual([]);
  });
});

describe("POST with a rated link", () => {
  it("keeping the type confirms the rate and its price; the seat does not move", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(rowWrite().where).toEqual({ id: "reg-1", ticketTypeId: "tt-phys", userId: null });
    expect(rowWrite().data).toMatchObject({ ticketTypeId: "tt-phys", pricingTierId: "t-eb", originalPrice: 250, paymentStatus: "UNASSIGNED" });
    expect(transitionMock.mock.calls[0][1]).toMatchObject({
      prev: { ticketTypeId: "tt-phys", pricingTierId: "t-eb" },
      next: { ticketTypeId: "tt-phys", pricingTierId: "t-eb" },
    });
    expect(confirmationMock.mock.calls[0][0]).toMatchObject({ ticketType: "Physician", pricingTierName: "Early Bird", ticketPrice: 250 });
  });

  it("changing the type prices the new one at the same rate and moves the seat (D5)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(NURSE);
    const res = await post({ ticketTypeId: "tt-nurse" });
    expect(res.status).toBe(200);
    expect(rowWrite().data).toMatchObject({ ticketTypeId: "tt-nurse", pricingTierId: "t-n-eb", originalPrice: 150 });
    expect(transitionMock.mock.calls[0][1]).toMatchObject({
      prev: { ticketTypeId: "tt-phys" },
      next: { ticketTypeId: "tt-nurse", pricingTierId: "t-n-eb" },
    });
    expect(tx.attendee.update.mock.calls[0][0].data).toMatchObject({ registrationType: "Nurse" });
  });

  it("a typeless registration picks a type and is priced at the link's rate", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ ticketTypeId: null, ticketType: null, pricingTier: null, pricingTierId: null, paymentStatus: "COMPLIMENTARY" }));
    const res = await post({ ticketTypeId: "tt-phys" });
    expect(res.status).toBe(200);
    expect(rowWrite().where).toEqual({ id: "reg-1", ticketTypeId: null, userId: null });
    expect(rowWrite().data).toMatchObject({ ticketTypeId: "tt-phys", originalPrice: 250, paymentStatus: "UNASSIGNED" });
    expect(transitionMock.mock.calls[0][1].prev).toMatchObject({ ticketTypeId: null });
  });

  it("refuses a closed rate (D3) and writes nothing", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(type({ pricingTiers: [rate({ salesEnd: new Date(Date.now() - DAY) })] }));
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "RATE_CLOSED" });
    expect(tx.registration.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a type without the link's rate", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(EXH);
    const res = await post({ ticketTypeId: "tt-exh" });
    expect(await res.json()).toMatchObject({ code: "RATE_NOT_ON_TYPE" });
    expect(tx.registration.updateMany).not.toHaveBeenCalled();
  });

  it("never touches a status holding money", async () => {
    mockDb.registration.findFirst.mockResolvedValue(registration({ paymentStatus: "PAID" }));
    await post();
    expect(rowWrite().data).not.toHaveProperty("paymentStatus");
  });

  it("a full type is a 409 and the whole write rolls back", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(NURSE);
    transitionMock.mockRejectedValue(new Error("CAPACITY_EXCEEDED"));
    const res = await post({ ticketTypeId: "tt-nurse" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "REGISTRATION_TYPE_SOLD_OUT" });
  });

  it("a sponsor rate with the sponsor on the registration is INCLUSIVE", async () => {
    token("regform:reg-1:inclusive");
    mockDb.registration.findFirst.mockResolvedValue(registration({ ticketTypeId: "tt-exh", sponsorId: "sp-1", pricingTierId: "t-inc" }));
    mockDb.ticketType.findFirst.mockResolvedValue(EXH);
    await post();
    expect(rowWrite().data).toMatchObject({ pricingTierId: "t-inc", originalPrice: 0, paymentStatus: "INCLUSIVE" });
  });

  it("complimentary: no rate, nothing to pay", async () => {
    token("regform:reg-1:complimentary");
    await post();
    expect(rowWrite().data).toMatchObject({ pricingTierId: null, originalPrice: 0, paymentStatus: "COMPLIMENTARY" });
  });
});
