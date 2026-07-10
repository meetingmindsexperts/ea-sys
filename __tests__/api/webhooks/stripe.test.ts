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
        updateMany: vi.fn(),
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

import { Prisma } from "@prisma/client";
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
    // Per-payment claim succeeds by default; registration roll-up returns the
    // post-increment total (tests override per scenario).
    mockDb.payment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.registration.update.mockResolvedValue({ refundedAmount: 100 });
    // Default: the reg's only settled payment is this $100 Stripe charge.
    mockDb.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    createCreditNoteMock.mockResolvedValue({ invoice: { id: "cn1" }, created: true });
  });

  // amount_refunded is CUMULATIVE (minor units); currency lowercase.
  const makeChargeEvent = (
    paymentIntentId: string | null,
    { amountRefunded = 10000, currency = "usd", created }: { amountRefunded?: number; currency?: string; created?: number } = {},
  ) =>
    makeStripeEvent("charge.refunded", {
      id: "ch_1",
      payment_intent: paymentIntentId,
      refunded: true,
      amount_refunded: amountRefunded,
      currency,
      ...(created !== undefined ? { created } : {}),
    });

  // Per-payment reconciliation (M4): `refundedAmount` here is the PAYMENT's
  // own counter — the number Stripe's per-charge cumulative reconciles against.
  const paymentRow = (refundedAmount: number, amount = 100) => ({
    id: "pay-1",
    amount,
    refundedAmount,
    registrationId: "reg-1",
    registration: { eventId: "evt-1", refundedAmount, event: { organizationId: "org-1" } },
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("reconciles a FULL Dashboard refund → refundedAmount + REFUNDED + credit note", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 })); // $100 of $100
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));
    mockDb.registration.update.mockResolvedValue({ refundedAmount: 100 });

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    // Per-payment claim: counter → cumulative, status flips (charge fully refunded).
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: 0 },
      data: { refundedAmount: 100, status: "REFUNDED" },
    });
    // Registration roll-up: delta incremented, then full → REFUNDED flip.
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { refundedAmount: { increment: 100 } },
      select: { refundedAmount: true },
    });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
  });

  it("M4: full refund of ONE charge on a mixed Stripe+manual reg keeps PAID and reconciles per-payment", async () => {
    // Reg collected $150 = $100 Stripe + $50 manual; a $50 MANUAL refund was
    // already recorded (reg counter 50). Dashboard fully refunds the $100
    // Stripe charge. Old code compared Stripe's cumulative against the MIXED
    // counter (delta = 100−50 = 50) and under-recorded; per-payment tracking
    // computes the true delta of 100.
    mockDb.payment.aggregate.mockResolvedValue({ _sum: { amount: 150 } });
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 })); // $100 refunded
    const row = paymentRow(0, 100);
    row.registration.refundedAmount = 50; // mixed counter already holds the manual refund
    mockDb.payment.findUnique.mockResolvedValue(row);
    mockDb.registration.update.mockResolvedValue({ refundedAmount: 150 }); // 50 + 100

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: 0 },
      data: { refundedAmount: 100, status: "REFUNDED" },
    });
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg-1" },
      data: { refundedAmount: { increment: 100 } }, // TRUE delta, not 50
      select: { refundedAmount: true },
    });
    // 150 refunded of 150 collected → full flip.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { id: "reg-1", paymentStatus: "PAID" },
      data: { paymentStatus: "REFUNDED" },
    });
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
  });

  it("reconciles a PARTIAL Dashboard refund → keeps PAID, credit note for the delta", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 3000 })); // $30 of $100
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));
    mockDb.registration.update.mockResolvedValue({ refundedAmount: 30 });

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: 0 },
      data: { refundedAmount: 30 }, // no status flip — charge not fully refunded
    });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled(); // no REFUNDED flip on partial
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 30 }));
  });

  it("only credits the incremental delta on a second (larger) refund", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 5000 })); // now $50 total
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(30, 100)); // $30 already reconciled on this charge
    mockDb.registration.update.mockResolvedValue({ refundedAmount: 50 });

    await POST(makeWebhookRequest());
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: 30 },
      data: { refundedAmount: 50 },
    });
    expect(mockDb.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { refundedAmount: { increment: 20 } } })
    );
    await flush();
    expect(createCreditNoteMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 })); // delta only
  });

  it("is idempotent — a retry with an already-reconciled total skips (no CN, no writes)", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(100, 100)); // charge already fully reconciled

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    await flush();
    expect(createCreditNoteMock).not.toHaveBeenCalled();
  });

  it("500s (Stripe retries) when a concurrent delivery moved the payment counter", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));
    mockDb.payment.updateMany.mockResolvedValue({ count: 0 }); // lost the per-payment claim

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(500);
    await flush();
    expect(createCreditNoteMock).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("warns and skips when no Payment record found for paymentIntentId (unknown charge age)", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_unknown"));
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "charge.refunded: no Payment record found" })
    );
  });

  it("returns 500 for a YOUNG charge with no Payment row so Stripe retries (out-of-order delivery, M3)", async () => {
    mockConstructEvent.mockReturnValue(
      makeChargeEvent("pi_racing", { created: Math.floor(Date.now() / 1000) - 60 }) // 1 min old
    );
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(500);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining("500 so Stripe retries") })
    );
  });

  it("acks an OLD charge with no Payment row (likely foreign to this system)", async () => {
    mockConstructEvent.mockReturnValue(
      makeChargeEvent("pi_ancient", { created: Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60 })
    );
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
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
  const paidRegistration = {
    id: "reg-1",
    paymentStatus: "PAID",
    status: "CONFIRMED",
    attendee: { firstName: "Alice", lastName: "Smith", email: "alice@test.com", additionalEmail: null, title: null },
    ticketType: { name: "Standard", price: 150, currency: "USD" },
    pricingTier: null,
    event: { id: "evt-1", organizationId: "org-1", name: "Conference", slug: "conf", startDate: new Date(), venue: null, city: null, taxRate: 0, taxLabel: null },
  };

  const completedEvent = makeStripeEvent("checkout.session.completed", {
    id: "cs_1",
    metadata: { registrationId: "reg-1" },
    currency: "usd",
    amount_total: 15000,
    payment_intent: "pi_1",
    customer: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ latest_charge: null });
  });

  it("skips entirely when this payment intent was already recorded (true webhook retry)", async () => {
    mockConstructEvent.mockReturnValue(completedEvent);
    mockDb.registration.findUnique.mockResolvedValue(paidRegistration);
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-existing" });

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.payment.findUnique).toHaveBeenCalledWith({
      where: { stripePaymentId: "pi_1" },
      select: { id: true },
    });
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe webhook: payment intent already recorded, skipping" })
    );
  });

  it("records a NEW charge on an already-PAID registration and raises a double-payment alert (H1)", async () => {
    mockConstructEvent.mockReturnValue(completedEvent);
    mockDb.registration.findUnique.mockResolvedValue(paidRegistration);
    mockDb.payment.findUnique.mockResolvedValue(null); // this intent has no row

    const tx = {
      registration: {
        findUnique: vi.fn().mockResolvedValue({ paymentStatus: "PAID" }),
        update: vi.fn(),
      },
      payment: { create: vi.fn().mockResolvedValue({ id: "pay-dup" }) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);

    // The second real settlement is on the books…
    expect(tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripePaymentId: "pi_1", status: "PAID" }) })
    );
    // …but the registration (already PAID) is untouched.
    expect(tx.registration.update).not.toHaveBeenCalled();

    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "stripe-webhook:duplicate-charge-recorded", registrationId: "reg-1" })
    );
    expect(vi.mocked(notifyEventAdmins)).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: expect.stringContaining("double payment") })
    );
    // No documents email for a charge that's about to be refunded.
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(issuePaidRegistrationDocuments)).not.toHaveBeenCalled();
  });

  it("treats an in-tx P2002 on stripePaymentId as an already-processed concurrent retry", async () => {
    mockConstructEvent.mockReturnValue(completedEvent);
    mockDb.registration.findUnique.mockResolvedValue({ ...paidRegistration, paymentStatus: "PENDING" });
    mockDb.payment.findUnique.mockResolvedValue(null);
    mockDb.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe webhook: concurrent retry already recorded this intent, skipping" })
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
    // Charge-level idempotency pre-check: this intent has no row yet.
    mockDb.payment.findUnique.mockResolvedValue(null);
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
