import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockDb,
  mockApiLogger,
  mockConstructEvent,
  mockStripeInstance,
} = vi.hoisted(() => {
  const mockConstructEvent = vi.fn();
  const mockStripeInstance = {
    webhooks: { constructEvent: mockConstructEvent },
    paymentIntents: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
  };
  return {
    mockDb: {
      registration: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      payment: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockConstructEvent,
    mockStripeInstance,
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => mockStripeInstance),
  fromStripeAmount: vi.fn((amount: number, currency: string) => {
    const zeroDecimal = ["JPY", "KRW"].includes(currency.toUpperCase());
    return zeroDecimal ? amount : amount / 100;
  }),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue(null),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "", htmlContent: "", textContent: "" }),
  brandingFrom: vi.fn().mockReturnValue({}),
  renderTemplatePlain: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/notifications", () => ({
  notifyEventAdmins: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/webhooks/stripe/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWebhookRequest(body = "{}") {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig_test" },
    body,
  });
}

function makeStripeEvent(type: string, data: object): object {
  return { type, data: { object: data } };
}

// ── Tests: signature verification ────────────────────────────────────────────

describe("Webhook: signature verification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 when stripe-signature header is missing", async () => {
    const req = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: "{}",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Missing stripe-signature header" });
  });

  it("returns 400 when signature verification fails", async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error("Signature mismatch"); });
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid signature" });
  });

  it("returns 500 when STRIPE_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(500);
    // Restore
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });
});

// ── Tests: checkout.session.expired ──────────────────────────────────────────

describe("Webhook: checkout.session.expired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("resets PENDING registration to UNPAID", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.expired", {
      id: "cs_exp_1",
      metadata: { registrationId: "reg-1" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", paymentStatus: "PENDING" },
      data: { paymentStatus: "UNPAID" },
    });
  });

  it("logs info when a registration is reset", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.expired", {
      id: "cs_exp_2",
      metadata: { registrationId: "reg-2" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });

    await POST(makeWebhookRequest());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Checkout session expired — registration reset to UNPAID" })
    );
  });

  it("does not log when no PENDING registration matched (already transitioned)", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.expired", {
      id: "cs_exp_3",
      metadata: { registrationId: "reg-3" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 });

    await POST(makeWebhookRequest());
    expect(mockApiLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("reset to UNPAID") })
    );
  });

  it("skips update when registrationId is missing from metadata", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.expired", {
      id: "cs_exp_4",
      metadata: {},
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });
});

// ── Tests: charge.refunded ────────────────────────────────────────────────────

describe("Webhook: charge.refunded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  const makeChargeEvent = (paymentIntentId: string | null) =>
    makeStripeEvent("charge.refunded", {
      id: "ch_1",
      payment_intent: paymentIntentId,
      refunded: true,
    });

  it("updates registration and payment to REFUNDED", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_refund_test"));
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-1", registrationId: "reg-1" });
    mockDb.$transaction.mockResolvedValue(undefined);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.$transaction).toHaveBeenCalled();
  });

  it("logs info on successful refund via webhook", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_refund_test"));
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-1", registrationId: "reg-1" });
    mockDb.$transaction.mockResolvedValue(undefined);

    await POST(makeWebhookRequest());
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Refund processed via Stripe webhook" })
    );
  });

  it("warns and skips when no Payment record found for paymentIntentId", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_unknown"));
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "charge.refunded: no Payment record found" })
    );
  });

  it("skips when paymentIntentId is missing from charge", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent(null));

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.payment.findUnique).not.toHaveBeenCalled();
  });
});

// ── Tests: payment_intent.payment_failed ──────────────────────────────────────

describe("Webhook: payment_intent.payment_failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("logs a warning with error code and message", async () => {
    const stripeEvent = makeStripeEvent("payment_intent.payment_failed", {
      id: "pi_failed_1",
      last_payment_error: { message: "Your card was declined.", code: "card_declined" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "Stripe payment failed",
        paymentIntentId: "pi_failed_1",
        error: "Your card was declined.",
        code: "card_declined",
      })
    );
  });

  it("uses 'Unknown error' when last_payment_error is absent", async () => {
    const stripeEvent = makeStripeEvent("payment_intent.payment_failed", {
      id: "pi_failed_2",
      last_payment_error: null,
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    await POST(makeWebhookRequest());
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Unknown error" })
    );
  });

  it("returns 200 received:true (does not fail the webhook)", async () => {
    const stripeEvent = makeStripeEvent("payment_intent.payment_failed", {
      id: "pi_failed_3",
      last_payment_error: { message: "Insufficient funds", code: "insufficient_funds" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    const res = await POST(makeWebhookRequest());
    const body = await res.json();
    expect(body).toMatchObject({ received: true });
  });
});

// ── Tests: checkout.session.completed — idempotency ──────────────────────────

describe("Webhook: checkout.session.completed idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("skips processing when registration is already PAID", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.completed", {
      id: "cs_1",
      metadata: { registrationId: "reg-1" },
      currency: "usd",
      amount_total: 15000,
      payment_intent: "pi_1",
      customer: null,
    });
    mockConstructEvent.mockReturnValue(stripeEvent);
    mockDb.registration.findUnique.mockResolvedValue({
      id: "reg-1",
      paymentStatus: "PAID",
      attendee: { firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
      ticketType: { name: "Standard", price: 150, currency: "USD" },
      pricingTier: null,
      event: { id: "evt-1", name: "Conference", slug: "conf", startDate: new Date(), venue: null, city: null, taxRate: 0, taxLabel: null },
    });

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe webhook: registration already paid, skipping" })
    );
  });

  it("skips processing when registrationId is missing from metadata", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.completed", {
      id: "cs_2",
      metadata: {},
      currency: "usd",
      amount_total: 10000,
      payment_intent: null,
      customer: null,
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.findUnique).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe checkout session missing registrationId metadata" })
    );
  });
});

// ── Tests: unknown event types ────────────────────────────────────────────────

describe("Webhook: unhandled event types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("returns 200 received:true for unhandled event types", async () => {
    const stripeEvent = makeStripeEvent("customer.created", { id: "cus_1" });
    mockConstructEvent.mockReturnValue(stripeEvent);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
  });
});
