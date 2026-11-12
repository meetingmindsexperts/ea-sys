/**
 * Payment Reminder to ONE registration from the detail sheet: refused when
 * nothing is owed (owner, Nov 12, 2026), by the same rule and the same
 * balance as the bulk send (payment-reminder-nothing-due.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, executeBulkEmailSpy, MockBulkEmailError } = vi.hoisted(() => {
  class MockBulkEmailError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 400, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      survey: { findFirst: vi.fn() },
      surveyResponse: { count: vi.fn() },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          firstName: "Rana",
          lastName: "Haddad",
          email: "rana@org.com",
          emailSignature: "<p>Rana</p>",
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
    mockAuth: vi.fn(),
    executeBulkEmailSpy: vi.fn(),
    MockBulkEmailError,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true }),
}));
vi.mock("@/lib/bulk-email", () => ({
  executeBulkEmail: executeBulkEmailSpy,
  BulkEmailError: MockBulkEmailError,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn(),
  getDefaultTemplate: vi.fn(),
  renderAndWrap: vi.fn(),
  renderMessageValue: vi.fn(),
  brandingFrom: vi.fn(),
  brandingCc: vi.fn(),
  sendRegistrationConfirmation: vi.fn(),
  eventLocationVars: (e: { city?: string | null; country?: string | null }) => ({ eventCity: e.city || "", eventCountry: e.country || "" }),
}));
vi.mock("@/lib/email-barcode", () => ({ buildEntryBarcode: vi.fn(), templateUsesEntryBarcode: () => false }));
vi.mock("@/lib/email-change", () => ({ normalizeEmail: vi.fn(), repointOrgContactEmail: vi.fn() }));

import { POST } from "@/app/api/events/[eventId]/registrations/[registrationId]/email/route";
import { getEventTemplate } from "@/lib/email";

const params = Promise.resolve({ eventId: "ev1", registrationId: "reg1" });
const send = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params });

function registration(extra: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    eventId: "ev1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    groupId: null,
    originalPrice: 200,
    discountAmount: null,
    ticketType: { id: "tt1", name: "Nurse", price: 0, currency: "USD" },
    pricingTier: { name: "Standard", price: 200, currency: "USD" },
    promoCode: null,
    payments: [],
    attendee: { firstName: "Sara", lastName: "Al Harthy", email: "sara@hospital.com", additionalEmail: null },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", slug: "gcc-hh26", name: "GCC Hub", organizationId: "org1", taxRate: 5, taxLabel: "VAT" });
});

const refusal = async (extra: Record<string, unknown>) => {
  mockDb.registration.findFirst.mockResolvedValue(registration(extra));
  const res = await send({ type: "payment-reminder" });
  return { status: res.status, body: (await res.json()) as { code?: string; error?: string } };
};

describe("payment reminder to one registration", () => {
  it("is refused when a code covers the whole fee, and says why", async () => {
    const r = await refusal({ discountAmount: 200, promoCode: { code: "GCCHH26SEHA" } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_BALANCE_DUE");
    expect(r.body.error).toContain("owes nothing");
  });

  it("is refused for a paid registration and for one paid in parts", async () => {
    expect((await refusal({ paymentStatus: "PAID", payments: [{ amount: 210, status: "PAID" }] })).body.code).toBe("NO_BALANCE_DUE");
    expect((await refusal({ payments: [{ amount: 105, status: "PAID" }, { amount: 105, status: "PAID" }] })).body.code).toBe("NO_BALANCE_DUE");
  });

  it("keeps its own words for complimentary and for no type yet", async () => {
    expect((await refusal({ paymentStatus: "COMPLIMENTARY" })).body.error).toContain("complimentary or sponsor-paid");
    expect((await refusal({ ticketType: null, pricingTier: null, originalPrice: null })).body.error).toContain("no type yet");
  });

  // The template lookup comes after the owes-nothing gate, so it is the proof
  // of which side of the gate a request ended on (this file mocks the lookup
  // to return nothing, so a request that passes the gate ends in a 500).
  it("goes on to the template when there is a balance to pay", async () => {
    const r = await refusal({});
    expect(r.body.code).not.toBe("NO_BALANCE_DUE");
    expect(getEventTemplate).toHaveBeenCalledTimes(1);
  });

  it("never reaches the template when nothing is owed", async () => {
    await refusal({ discountAmount: 200 });
    expect(getEventTemplate).not.toHaveBeenCalled();
  });

  it("loads the payments the balance is worked out from", async () => {
    await refusal({});
    expect(mockDb.registration.findFirst.mock.calls[0][0].include.payments).toEqual({ select: { amount: true, status: true } });
  });
});
