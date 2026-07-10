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
        findFirst: vi.fn(),
        update: vi.fn(),
        aggregate: vi.fn(),
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
const createCreditNoteMock = vi.fn().mockResolvedValue({ invoice: { id: "cn1" }, created: true });
const sendInvoiceEmailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/invoice-service", () => ({
  createCreditNote: (...args: unknown[]) => createCreditNoteMock(...args),
  sendInvoiceEmail: (...args: unknown[]) => sendInvoiceEmailMock(...args),
  issuePaidRegistrationDocuments: vi.fn().mockResolvedValue(undefined),
}));
// Fire-and-forget Stripe-receipt snapshot — mock so no real fetch happens.
vi.mock("@/lib/stripe-receipt", () => ({
  captureStripeReceipt: vi.fn().mockResolvedValue("/uploads/stripe-receipts/x.html"),
}));
vi.mock("@/lib/event-stats", () => ({
  refreshEventStats: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/stripe/route";
import { notifyEventAdmins } from "@/lib/notifications";
import { issuePaidRegistrationDocuments } from "@/lib/invoice-service";

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

describe("Webhook: charge.refunded (reconciliation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb.payment.update.mockResolvedValue({});
    // Default: the reg's only PAID payment is this $100 Stripe charge.
    mockDb.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    createCreditNoteMock.mockResolvedValue({ invoice: { id: "cn1" }, created: true });
  });

  // amount_refunded is CUMULATIVE (minor units); currency lowercase.
  const makeChargeEvent = (
    paymentIntentId: string | null,
    { amountRefunded = 10000, currency = "usd" }: { amountRefunded?: number; currency?: string } = {},
  ) =>
    makeStripeEvent("charge.refunded", {
      id: "ch_1",
      payment_intent: paymentIntentId,
      refunded: true,
      amount_refunded: amountRefunded,
      currency,
    });

  const paymentRow = (refundedAmount: number, amount = 100) => ({
    id: "pay-1",
    amount,
    registrationId: "reg-1",
    registration: { eventId: "evt-1", refundedAmount, event: { organizationId: "org-1" } },
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("reconciles a FULL Dashboard refund → refundedAmount + REFUNDED + credit note", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 })); // $100 of $100
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", refundedAmount: { lt: 100 } },
      data: { refundedAmount: 100, paymentStatus: "REFUNDED" },
    });
    expect(mockDb.payment.update).toHaveBeenCalledWith({ where: { id: "pay-1" }, data: { status: "REFUNDED" } });
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
  });

  it("H2: full refund of ONE charge on a multi-payment reg keeps PAID (paidTotal = sum of all PAID)", async () => {
    // Reg collected $100 = $60 Stripe + $40 manual. Dashboard fully refunds the
    // $60 Stripe charge. paidTotal must be $100 (aggregate), so isFull is false.
    mockDb.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 6000 })); // $60 refunded
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 60)); // this charge is $60

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", refundedAmount: { lt: 60 } },
      data: { refundedAmount: 60 }, // NO REFUNDED flip — $40 manual still owed
    });
    expect(mockDb.payment.update).not.toHaveBeenCalled();
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 60 }));
  });

  it("reconciles a PARTIAL Dashboard refund → keeps PAID, credit note for the delta", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 3000 })); // $30 of $100
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", refundedAmount: { lt: 30 } },
      data: { refundedAmount: 30 }, // no REFUNDED flip on partial
    });
    expect(mockDb.payment.update).not.toHaveBeenCalled();
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 30 }));
  });

  it("only credits the incremental delta on a second (larger) refund", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 5000 })); // now $50 total
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(30, 100)); // $30 already reconciled

    await POST(makeWebhookRequest());
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", refundedAmount: { lt: 50 } },
      data: { refundedAmount: 50 },
    });
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 })); // delta only
  });

  it("is idempotent — a retry with an already-reconciled total skips (no CN, no writes)", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(100, 100)); // already fully reconciled

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    await flush();
    expect(createCreditNoteMock).not.toHaveBeenCalled();
  });

  it("skips the credit note when a concurrent delivery already claimed the delta", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));
    mockDb.registration.updateMany.mockResolvedValue({ count: 0 }); // lost the race

    await POST(makeWebhookRequest());
    await flush();
    expect(createCreditNoteMock).not.toHaveBeenCalled();
    expect(mockDb.payment.update).not.toHaveBeenCalled();
  });

  it("warns and skips when no Payment record found for paymentIntentId", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_unknown"));
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
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

// ── Tests: checkout.session.completed — CANCELLED registration (H2) ─────────

describe("Webhook: checkout.session.completed on a CANCELLED registration", () => {
  const sessionData = {
    id: "cs_cancel_1",
    metadata: { registrationId: "reg-c1" },
    currency: "usd",
    amount_total: 15000,
    payment_intent: "pi_c1",
    customer: null,
  };

  const baseRegistration = {
    id: "reg-c1",
    paymentStatus: "PENDING",
    status: "CONFIRMED",
    attendee: { firstName: "Alice", lastName: "Smith", email: "alice@test.com", additionalEmail: null, title: null },
    ticketType: { name: "Standard", price: 150, currency: "USD" },
    pricingTier: null,
    event: { id: "evt-1", organizationId: "org-1", name: "Conference", slug: "conf", startDate: new Date(), venue: null, city: null, taxRate: 0, taxLabel: null },
  };

  function mockHappyStripeReads() {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ latest_charge: "ch_1" });
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      receipt_url: null,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
      created: 1_700_000_000,
    });
  }

  function mockTransaction() {
    const tx = {
      registration: {
        findUnique: vi.fn().mockResolvedValue({ paymentStatus: "PENDING" }),
        update: vi.fn().mockResolvedValue({}),
      },
      payment: { create: vi.fn().mockResolvedValue({ id: "pay-1" }) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
    return tx;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockConstructEvent.mockReturnValue(makeStripeEvent("checkout.session.completed", sessionData));
    mockHappyStripeReads();
    mockDb.payment.findFirst.mockResolvedValue({ id: "pay-1" });
  });

  it("records the payment truthfully but suppresses documents and raises a refund-required alert", async () => {
    mockDb.registration.findUnique.mockResolvedValue({ ...baseRegistration, status: "CANCELLED" });
    const tx = mockTransaction();

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);

    // Money truth: the Payment row is created and the reg flips PAID so the
    // gated refund flow can reverse it.
    expect(tx.payment.create).toHaveBeenCalled();
    expect(tx.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: "PAID" } })
    );

    // Loud flag: error-level log + refund-required admin notification.
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-webhook:payment-on-cancelled-registration", registrationId: "reg-c1" })
    );
    expect(vi.mocked(notifyEventAdmins)).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: expect.stringContaining("CANCELLED") })
    );

    // No attendee-facing documents email for a cancelled registration.
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(issuePaidRegistrationDocuments)).not.toHaveBeenCalled();
  });

  it("keeps the normal fan-out for a non-cancelled registration (regression)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(baseRegistration);
    mockTransaction();

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);

    expect(vi.mocked(notifyEventAdmins)).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: "Payment Received" })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(issuePaidRegistrationDocuments)).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg-c1", eventId: "evt-1" })
    );
    expect(mockApiLogger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-webhook:payment-on-cancelled-registration" })
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
