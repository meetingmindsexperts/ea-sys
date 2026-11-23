/**
 * POST /api/public/events/[slug]/checkout — charging gates (July 10, 2026).
 *
 * Pins the B1 fix (NO_PAYMENT_DUE gate: INCLUSIVE / REFUNDED can no longer
 * reach Stripe — sponsor-paid regs were double-collectable) and the H3 fix
 * (the post-session PENDING flip is a conditional claim, not a blind write —
 * a concurrent settlement wins and the stale session is expired).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockSessionsCreate, mockSessionsExpire } = vi.hoisted(() => ({
  mockDb: {
    registration: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockSessionsCreate: vi.fn(),
  mockSessionsExpire: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => ({
    checkout: { sessions: { create: mockSessionsCreate, expire: mockSessionsExpire } },
  })),
  isZeroDecimalCurrency: (c: string) => ["jpy", "krw"].includes(c.toLowerCase()),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  getClientIp: vi.fn(() => "1.2.3.4"),
}));

import { POST } from "@/app/api/public/events/[slug]/checkout/route";

function makeRequest(registrationId = "reg-1") {
  return new Request("http://localhost/api/public/events/conf/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registrationId }),
  });
}

const params = { params: Promise.resolve({ slug: "conf" }) };

function makeRegistration(paymentStatus: string) {
  return {
    id: "reg-1",
    paymentStatus,
    originalPrice: null,
    discountAmount: null,
    ticketType: { id: "tt-1", name: "Standard", price: 100, currency: "USD" },
    pricingTier: null,
    attendee: { firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
    event: { id: "evt-1", name: "Conference", slug: "conf", taxRate: 0, taxLabel: null },
    promoCode: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" });
  mockSessionsExpire.mockResolvedValue({});
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST checkout — NO_PAYMENT_DUE gate (B1)", () => {
  it.each([
    ["INCLUSIVE", "sponsor-paid"],
    ["REFUNDED", "refunded"],
    ["PAID", "already completed"],
    ["COMPLIMENTARY", "already completed"],
  ])("rejects %s with 400 and never creates a Stripe session", async (status, messageFragment) => {
    mockDb.registration.findFirst.mockResolvedValue(makeRegistration(status));

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toContain(messageFragment);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Checkout attempted for a no-payment-due registration", paymentStatus: status })
    );
  });
});

describe("POST checkout — conditional PENDING claim (H3)", () => {
  it("claims PENDING with a notIn guard on the no-payment-due statuses", async () => {
    mockDb.registration.findFirst.mockResolvedValue(makeRegistration("UNPAID"));

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkoutUrl: "https://checkout.stripe.test/cs_1" });

    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reg-1",
        paymentStatus: { notIn: ["PAID", "COMPLIMENTARY", "INCLUSIVE", "REFUNDED"] },
      },
      // Session id stored so a later cancel can expire the open payment tab (H2).
      data: { paymentStatus: "PENDING", stripeCheckoutSessionId: "cs_1" },
    });
    expect(mockSessionsExpire).not.toHaveBeenCalled();
  });

  it("expires the just-created session and 400s when a concurrent settlement wins the claim", async () => {
    mockDb.registration.findFirst.mockResolvedValue(makeRegistration("UNPAID"));
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Payment already completed" });
    expect(mockSessionsExpire).toHaveBeenCalledWith("cs_1");
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Checkout lost race to a concurrent settlement — session expired", sessionId: "cs_1" })
    );
  });

  it("still 400s (and logs) when expiring the stale session itself fails — the claim result wins", async () => {
    mockDb.registration.findFirst.mockResolvedValue(makeRegistration("UNPAID"));
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });
    mockSessionsExpire.mockRejectedValue(new Error("stripe down"));

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Failed to expire stale checkout session" })
    );
  });
});

// Owner, Nov 23, 2026 (author-payment-hold.ts): an abstract author's fee is
// confirmed after review. The pages hide Pay Now; this is the door itself.
describe("POST checkout: an abstract author's registration on hold", () => {
  const author = (settings: unknown, createdSource = "PUBLIC_SUBMITTER") => {
    const registration = makeRegistration("UNASSIGNED");
    return { ...registration, createdSource, event: { ...registration.event, settings } };
  };

  it("refuses with the hold's code while the event's switch is off, and never reaches Stripe", async () => {
    mockDb.registration.findFirst.mockResolvedValue(author({ presenterRegistration: { payNowEnabled: false } }));
    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("AUTHOR_PAYMENT_ON_HOLD");
    expect(body.error).toContain("Online payment is not open yet");
    expect(mockSessionsCreate).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Checkout attempted for an author's registration on hold", registrationId: "reg-1" }),
    );
  });

  it("refuses when the event has no setting saved at all: off is the default", async () => {
    mockDb.registration.findFirst.mockResolvedValue(author(null));
    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(400);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it("takes the payment once the organisers turn the switch on", async () => {
    mockDb.registration.findFirst.mockResolvedValue(author({ presenterRegistration: { payNowEnabled: true } }));
    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(200);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("never holds an ordinary delegate's registration, switch off or not", async () => {
    mockDb.registration.findFirst.mockResolvedValue(author({ presenterRegistration: { payNowEnabled: false } }, "PUBLIC_REGISTER"));
    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(200);
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it("a settled author's registration still gets the settled answer, not the hold", async () => {
    const registration = makeRegistration("COMPLIMENTARY");
    mockDb.registration.findFirst.mockResolvedValue({ ...registration, createdSource: "PUBLIC_SUBMITTER", event: { ...registration.event, settings: null } });
    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBeUndefined();
  });

  it("reads the event's settings for it", async () => {
    mockDb.registration.findFirst.mockResolvedValue(author(null));
    await POST(makeRequest(), params);

    expect(mockDb.registration.findFirst.mock.calls[0][0].include.event.select.settings).toBe(true);
  });
});

