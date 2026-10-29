/**
 * POST /api/events/[eventId]/registrations/walk-in: the onsite desk's one step
 * (docs/ONSITE_DESK_PLAN.md §4). Each step is the shared service, so these pin
 * how the route chains them: what it asks each service for, and that a step
 * failing after the registration exists answers `registered: true` with the
 * reason rather than an error the desk would retry into a duplicate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockCreate, mockRecordPayment, mockExecuteCheckIn } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    ticketType: { findFirst: vi.fn() },
  },
  mockCreate: vi.fn(),
  mockRecordPayment: vi.fn(),
  mockExecuteCheckIn: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));
vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock("@/services/registration-service", () => ({ createRegistration: (...a: unknown[]) => mockCreate(...a) }));
vi.mock("@/services/payment-service", () => ({
  MANUAL_PAYMENT_EVENT_SELECT: { id: true },
  recordManualPayment: (...a: unknown[]) => mockRecordPayment(...a),
}));
vi.mock("@/lib/check-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/check-in")>()),
  executeCheckIn: (...a: unknown[]) => mockExecuteCheckIn(...a),
}));

import { POST } from "@/app/api/events/[eventId]/registrations/walk-in/route";

const session = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1", firstName: "Dana", lastName: "Desk" } };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const EVENT = { id: "evt-1", organizationId: "org-1", taxRate: null, taxLabel: null };
// Every field the public form requires (owner, Oct 29 2026).
const base = {
  title: "DR",
  role: "PHYSICIAN",
  firstName: "Walk",
  lastName: "In",
  email: "walk@test.local",
  organization: "Hospital",
  jobTitle: "Consultant",
  phone: "+971500000000",
  city: "Dubai",
  country: "United Arab Emirates",
  specialty: "Hematology",
  ticketTypeId: "tt1",
  pricingTierId: "tier1",
};
const PLAIN_TYPE = { price: 0, pricingTiers: [{ name: "Standard", price: 100 }], requiresMemberId: false, requiresStudentId: false, requiresStudentIdExpiry: false, requiresDocument: false, documentRequired: false, documentLabel: null };
// Complimentary is offered on a free rate only (owner, Oct 29): the Complimentary rate.
const COMP_TYPE = { ...PLAIN_TYPE, pricingTiers: [{ name: "Complimentary", price: 0 }] };

const post = (body: unknown) =>
  POST(new Request("http://x/api/events/evt-1/registrations/walk-in", { method: "POST", body: JSON.stringify(body) }), params);

/** The row the check-in gate reads after create (and payment). */
function freshRow(paymentStatus: string, price = 100) {
  return { status: "CONFIRMED", paymentStatus, checkedInAt: null, originalPrice: price, ticketType: { price: 0 }, pricingTier: { price } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.ticketType.findFirst.mockResolvedValue(PLAIN_TYPE);
  mockCreate.mockResolvedValue({
    ok: true,
    registration: { id: "reg-1", serialId: 7, paymentStatus: "UNASSIGNED", attendee: { firstName: "Walk", lastName: "In" }, ticketType: { name: "Physician" } },
    dtcm: "not-applicable",
  });
  mockRecordPayment.mockResolvedValue({ ok: true, summary: { fullyPaid: true } });
  mockExecuteCheckIn.mockResolvedValue({ id: "reg-1" });
  mockRateLimit.mockReturnValue({ allowed: true });
});

describe("POST walk-in", () => {
  it("complimentary: created comp with the sales window overridden, no payment, checked in", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(COMP_TYPE);
    mockDb.registration.findFirst.mockResolvedValue(freshRow("COMPLIMENTARY"));
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ registered: true, checkedIn: true, registrationId: "reg-1", name: "Walk In" });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentStatus: "COMPLIMENTARY",
        overrideSalesWindow: true,
        suppressConfirmationEmail: false,
        pricingTierId: "tier1",
        detailsComplete: true,
        supportingDocument: null,
        attendee: expect.objectContaining({
          email: "walk@test.local",
          title: "DR",
          role: "PHYSICIAN",
          organization: "Hospital",
          jobTitle: "Consultant",
          country: "United Arab Emirates",
          specialty: "Hematology",
        }),
      }),
    );
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(mockExecuteCheckIn).toHaveBeenCalledWith(expect.objectContaining({ registrationId: "reg-1", auditExtras: expect.objectContaining({ deskWalkIn: true }) }));
  });

  it("cash: the capture defers its documents, names the operator, and the confirmation email is suppressed", async () => {
    mockDb.registration.findFirst.mockResolvedValue(freshRow("PAID"));
    const res = await post({ ...base, payment: "cash" });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ paymentStatus: undefined, suppressConfirmationEmail: true }));
    expect(mockRecordPayment).toHaveBeenCalledWith(
      expect.objectContaining({ event: EVENT, registrationId: "reg-1", method: "cash", cashReceivedBy: "Dana Desk", deferDocuments: true }),
    );
    expect(mockExecuteCheckIn).toHaveBeenCalled();
  });

  it("card needs the last 4 digits; nothing is created without them", async () => {
    const res = await post({ ...base, payment: "card" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("card records card_onsite with the digits", async () => {
    mockDb.registration.findFirst.mockResolvedValue(freshRow("PAID"));
    await post({ ...base, payment: "card", cardLast4: "4242" });
    expect(mockRecordPayment).toHaveBeenCalledWith(expect.objectContaining({ method: "card_onsite", cardLast4: "4242" }));
  });

  it("already registered: the service's refusal and the existing id go back to the desk", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(COMP_TYPE);
    mockCreate.mockResolvedValue({ ok: false, code: "ALREADY_REGISTERED", message: "Already registered", meta: { existingRegistrationId: "reg-0" } });
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "ALREADY_REGISTERED", existingRegistrationId: "reg-0" });
    expect(mockExecuteCheckIn).not.toHaveBeenCalled();
  });

  it("a payment that fails after create answers registered, not checked in, with the reason", async () => {
    mockRecordPayment.mockResolvedValue({ ok: false, code: "ZERO_AMOUNT", message: "Amount must be greater than zero." });
    const res = await post({ ...base, payment: "cash" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registered: true, checkedIn: false, step: "payment", code: "ZERO_AMOUNT" });
    expect(mockExecuteCheckIn).not.toHaveBeenCalled();
  });

  it("the door's own gate still decides: money still owed is not checked in", async () => {
    mockDb.registration.findFirst.mockResolvedValue(freshRow("UNASSIGNED"));
    const res = await post({ ...base, payment: "cash" });
    expect(await res.json()).toMatchObject({ registered: true, checkedIn: false, step: "check-in", code: "PAYMENT_REQUIRED" });
    expect(mockExecuteCheckIn).not.toHaveBeenCalled();
  });

  it("an event outside the caller's grant is a 404 before anything is created", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a walk-in missing a field the public form requires, before anything is created", async () => {
    for (const key of ["title", "role", "organization", "jobTitle", "phone", "city", "country", "specialty"] as const) {
      const { [key]: _omitted, ...rest } = base;
      void _omitted;
      const res = await post({ ...rest, payment: "complimentary" });
      expect(res.status, key).toBe(400);
    }
    const others = await post({ ...base, specialty: "Others", payment: "complimentary" });
    expect(others.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("asks for what the type asks for: a member ID", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ ...COMP_TYPE, requiresMemberId: true });
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "IDENTITY_EVIDENCE_REQUIRED" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a required supporting document must be this event's upload, and is stored when it is", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ ...COMP_TYPE, requiresDocument: true, documentRequired: true, documentLabel: "Resident letter" });
    const missing = await post({ ...base, payment: "complimentary" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "SUPPORTING_DOCUMENT_REQUIRED", error: "Resident letter is required for this type" });

    mockDb.registration.findFirst.mockResolvedValue(freshRow("COMPLIMENTARY"));
    const url = "/uploads/resident-letters/evt-1/0b1c2d3e-aaaa-bbbb-cccc-123456789abc.pdf";
    const ok = await post({ ...base, payment: "complimentary", supportingDocumentUrl: url, supportingDocumentFilename: "letter.pdf" });
    expect(ok.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ supportingDocument: { url, filename: "letter.pdf" } }));
  });

  it("a type from another event is a 404", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a paid walk-in on a free rate is refused before anything is created", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ ...PLAIN_TYPE, pricingTiers: [] });
    const res = await post({ ...base, pricingTierId: undefined, payment: "cash" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "PAYMENT_NOT_FOR_RATE", allowed: ["complimentary"] });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("complimentary on a paid rate is refused before anything is created (owner, Oct 29)", async () => {
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "PAYMENT_NOT_FOR_RATE", allowed: ["cash", "card", "inclusive"] });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a sponsor-link rate takes only the sponsor's code", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: { codeRequiredTiers: ["inclusive"] } });
    mockDb.ticketType.findFirst.mockResolvedValue({ ...PLAIN_TYPE, pricingTiers: [{ name: "Inclusive", price: 0 }] });
    for (const payment of ["complimentary", "cash"]) {
      const res = await post({ ...base, payment });
      expect(await res.json()).toMatchObject({ code: "PAYMENT_NOT_FOR_RATE", allowed: ["inclusive"] });
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("the event must satisfy every key's scope: create and check-in, and payments when paid (review MED 1)", async () => {
    mockDb.registration.findFirst.mockResolvedValue(freshRow("PAID"));
    mockDb.ticketType.findFirst.mockResolvedValue(COMP_TYPE);
    await post({ ...base, payment: "complimentary" });
    expect(mockDb.event.findFirst.mock.calls[0][0].where.AND).toHaveLength(2);
    mockDb.event.findFirst.mockClear();
    mockDb.ticketType.findFirst.mockResolvedValue(PLAIN_TYPE);
    await post({ ...base, payment: "cash" });
    expect(mockDb.event.findFirst.mock.calls[0][0].where.AND).toHaveLength(3);
  });

  it("an exception after the row exists still answers registered (review MED 2)", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(COMP_TYPE);
    mockDb.registration.findFirst.mockResolvedValue(freshRow("COMPLIMENTARY"));
    mockExecuteCheckIn.mockRejectedValue(new Error("db blip"));
    const res = await post({ ...base, payment: "complimentary" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ registered: true, checkedIn: false, registrationId: "reg-1", code: "UNKNOWN" });
  });

  it("a paid walk-in spends the manual-payment bucket, refused before anything is created (review LOW 6)", async () => {
    mockRateLimit.mockImplementation(({ key }: { key: string }) =>
      key.startsWith("manual-payment:") ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true },
    );
    const paidRes = await post({ ...base, payment: "cash" });
    expect(paidRes.status).toBe(429);
    expect(mockCreate).not.toHaveBeenCalled();

    mockDb.ticketType.findFirst.mockResolvedValue(COMP_TYPE);
    mockDb.registration.findFirst.mockResolvedValue(freshRow("COMPLIMENTARY"));
    const compRes = await post({ ...base, payment: "complimentary" });
    expect(compRes.status).toBe(201);
  });

  it("inclusive: the sponsor's code goes to the service as sponsor-only, and no payment is taken", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      registration: { id: "reg-1", serialId: 7, paymentStatus: "INCLUSIVE", attendee: { firstName: "Walk", lastName: "In" }, ticketType: { name: "Physician" } },
      dtcm: "not-applicable",
    });
    mockDb.registration.findFirst.mockResolvedValue(freshRow("INCLUSIVE"));
    const res = await post({ ...base, payment: "inclusive", promoCode: "PFIZER10", expectedPrice: 0 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ checkedIn: true, paymentStatus: "INCLUSIVE" });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ promoCode: "PFIZER10", requireSponsorCode: true, paymentStatus: undefined, expectedPrice: 0 }));
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });

  it("inclusive works on a sponsor's $0 link rate, and needs no payment permission or bucket", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: { codeRequiredTiers: ["inclusive"] } });
    mockDb.ticketType.findFirst.mockResolvedValue({ ...PLAIN_TYPE, pricingTiers: [{ name: "Inclusive", price: 0 }] });
    mockDb.registration.findFirst.mockResolvedValue(freshRow("INCLUSIVE", 0));
    const res = await post({ ...base, payment: "inclusive", promoCode: "PFIZER10", expectedPrice: 0 });
    expect(res.status).toBe(201);
    expect(mockRateLimit).toHaveBeenCalledTimes(1);
  });

  it("inclusive without a code is refused before anything is created", async () => {
    const res = await post({ ...base, payment: "inclusive" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("a code on a complimentary walk-in is refused", async () => {
    const res = await post({ ...base, payment: "complimentary", promoCode: "SAVE20" });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("cash with a discount code: the code goes to the service and the payment takes the discounted balance", async () => {
    mockDb.registration.findFirst.mockResolvedValue(freshRow("PAID"));
    const res = await post({ ...base, payment: "cash", promoCode: "SAVE20", expectedPrice: 80 });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ promoCode: "SAVE20", requireSponsorCode: false, expectedPrice: 80 }));
    // No amount: the service defaults to the balance, which reads the stored discount.
    expect(mockRecordPayment).toHaveBeenCalledWith(expect.not.objectContaining({ amount: expect.anything() }));
  });

  it("covered: a code that leaves nothing to pay records no payment and needs no payment right or bucket", async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      registration: { id: "reg-1", serialId: 7, paymentStatus: "COMPLIMENTARY", attendee: { firstName: "Walk", lastName: "In" }, ticketType: { name: "Physician" } },
      dtcm: "not-applicable",
    });
    mockDb.registration.findFirst.mockResolvedValue(freshRow("COMPLIMENTARY"));
    const res = await post({ ...base, payment: "covered", promoCode: "FREE100", expectedPrice: 0 });
    expect(res.status).toBe(201);
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(mockRateLimit).toHaveBeenCalledTimes(1);
    expect(mockExecuteCheckIn).toHaveBeenCalled();
  });

  it("a refused code creates nothing and answers with the service's code", async () => {
    mockCreate.mockResolvedValue({ ok: false, code: "PROMO_CODE_EXHAUSTED", message: "Promo code usage limit reached" });
    const res = await post({ ...base, payment: "inclusive", promoCode: "PFIZER10", expectedPrice: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PROMO_CODE_EXHAUSTED" });
    expect(mockExecuteCheckIn).not.toHaveBeenCalled();
  });

  it("a code without the price the desk showed, or covered with a price, is refused before anything is created", async () => {
    expect((await post({ ...base, payment: "cash", promoCode: "SAVE20" })).status).toBe(400);
    expect((await post({ ...base, payment: "covered", promoCode: "FREE100", expectedPrice: 20 })).status).toBe(400);
    expect((await post({ ...base, payment: "covered", expectedPrice: 0 })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("PRICE_CHANGED from the service: nothing collected, nothing checked in", async () => {
    mockCreate.mockResolvedValue({ ok: false, code: "PRICE_CHANGED", message: "The price changed" });
    const res = await post({ ...base, payment: "covered", promoCode: "FREE100", expectedPrice: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PRICE_CHANGED" });
    expect(mockRecordPayment).not.toHaveBeenCalled();
    expect(mockExecuteCheckIn).not.toHaveBeenCalled();
  });
});
