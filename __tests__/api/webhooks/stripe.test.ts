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
      auditLog: { create: vi.fn().mockResolvedValue({}) },
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
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated sites.
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/stripe", () => ({
  // Signature verification no longer routes through getStripe (Aug 24,
  // 2026): it is static crypto and must not depend on a resolvable API
  // key. Same underlying spy, so existing expectations still hold.
  verifyWebhookSignature: vi.fn((body: unknown, sig: string, secret: string) =>
    mockConstructEvent(body, sig, secret),
  ),
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
vi.mock("@/lib/invoice-service", () => ({
  issuePaidRegistrationDocuments: vi.fn().mockResolvedValue(undefined),
}));
// H11: Dashboard-refund credit notes now go through the payment SERVICE
// (owns the CREDIT_NOTE_ISSUED audit + logs cap rejections), send:false.
const issueCreditNoteSpy = vi.fn().mockResolvedValue({ ok: true, creditNote: { creditNoteId: "cn1" } });
vi.mock("@/services/payment-service", () => ({
  issueCreditNoteForRegistration: (...args: unknown[]) => issueCreditNoteSpy(...args),
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
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";
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
      data: { paymentStatus: "UNPAID", stripeCheckoutSessionId: null }, // pointer cleared (H2)
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
    issueCreditNoteSpy.mockResolvedValue({ ok: true, creditNote: { creditNoteId: "cn1" } });
    mockDb.auditLog.create.mockResolvedValue({});
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
    registration: {
      eventId: "evt-1",
      refundedAmount,
      attendee: { firstName: "Alice", lastName: "Smith" },
      event: { organizationId: "org-1" },
    },
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
    // H11: Dashboard refunds carry the service side-effect contract — audit
    // row, admin notification, credit note via the SERVICE with send:false
    // (no attendee email — same policy as route-initiated refunds).
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "REFUND_ISSUED",
          changes: expect.objectContaining({ source: "stripe-webhook", amount: 100 }),
        }),
      }),
    );
    expect(vi.mocked(notifyEventAdmins)).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: expect.stringContaining("reconciled from Stripe") }),
    );
    await flush();
    expect(issueCreditNoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, send: false, source: "system" }),
    );
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
    expect(issueCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
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
    expect(issueCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 30 }));
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
    expect(issueCreditNoteSpy).toHaveBeenCalledWith(expect.objectContaining({ amount: 20 })); // delta only
  });

  it("is idempotent — a retry with an already-reconciled total skips (no CN, no writes)", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(100, 100)); // charge already fully reconciled

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(200);
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    await flush();
    expect(issueCreditNoteSpy).not.toHaveBeenCalled();
  });

  it("500s (Stripe retries) when a concurrent delivery moved the payment counter", async () => {
    mockConstructEvent.mockReturnValue(makeChargeEvent("pi_1", { amountRefunded: 10000 }));
    mockDb.payment.findUnique.mockResolvedValue(paymentRow(0, 100));
    mockDb.payment.updateMany.mockResolvedValue({ count: 0 }); // lost the per-payment claim

    const res = await POST(makeWebhookRequest());
    expect(res.status).toBe(500);
    await flush();
    expect(issueCreditNoteSpy).not.toHaveBeenCalled();
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
        findUnique: vi.fn().mockResolvedValue({ paymentStatus: "PAID", event: { organizationId: "org-1" } }),
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
      expect.objectContaining({ msg: expect.stringContaining("foreign-checkout-session-ignored") })
    );
  });

  // The log line has to answer "did money move, and where did this come from?"
  // WITHOUT a follow-up lookup. It used to carry only `sessionId` — the one
  // field the Stripe Dashboard cannot search (it indexes customers, payments,
  // invoices and subscriptions, NOT Checkout Session ids), so the id returned
  // "no results found" and the investigation dead-ended. Aug 14, 2026.
  it("logs enough to diagnose an unrecognised session without leaving the log", async () => {
    const stripeEvent = makeStripeEvent("checkout.session.completed", {
      id: "cs_live_unknown",
      metadata: {},
      mode: "payment",
      payment_status: "paid",
      currency: "aed",
      amount_total: 45000,
      payment_intent: "pi_live_abc",
      payment_link: "plink_live_xyz",
      invoice: null,
      customer: null,
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    await POST(makeWebhookRequest());

    const logged = mockApiLogger.warn.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a?.msg === "string" && a.msg.includes("checkout-session"));

    // Did money move?
    expect(logged.paymentStatus).toBe("paid");
    expect(logged.amountTotal).toBe(45000);
    expect(logged.mode).toBe("payment");
    // Where did it come from? A Payment Link is the benign-but-consequential
    // case: real money, outside EA-SYS's books, registration still chased.
    expect(logged.paymentLinkId).toBe("plink_live_xyz");
    // Dashboard-searchable, unlike the session id.
    expect(logged.paymentIntentId).toBe("pi_live_abc");
  });

  it("does not log the customer email", async () => {
    // This is an unrecognised-payment signal, not a receipt, and SystemLog is
    // read on a dashboard by anyone with the role. The Stripe ids above are
    // enough to find the person when that is genuinely needed.
    const stripeEvent = makeStripeEvent("checkout.session.completed", {
      id: "cs_live_unknown2",
      metadata: {},
      currency: "usd",
      amount_total: 100,
      payment_intent: null,
      customer: null,
      customer_email: "someone@hospital.org",
      customer_details: { email: "someone@hospital.org" },
    });
    mockConstructEvent.mockReturnValue(stripeEvent);

    await POST(makeWebhookRequest());

    const logged = mockApiLogger.warn.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a?.msg === "string" && a.msg.includes("checkout-session"));
    expect(JSON.stringify(logged)).not.toContain("someone@hospital.org");
  });

  // Both stay at WARN (owner: "info I don't notice, warning I notice"). What
  // changes is that they are TELLABLE APART, because they mean opposite things
  // and the benign one recurs every few days. Under one message the rare real
  // failure gets dismissed along with the routine noise.
  it("labels a foreign session (no metadata) distinctly from one of ours that lost its tags", async () => {
    const foreign = makeStripeEvent("checkout.session.completed", {
      id: "cs_live_foreign",
      metadata: {},
      currency: "usd",
      amount_total: 10000,
      payment_intent: null,
      customer: null,
    });
    mockConstructEvent.mockReturnValue(foreign);
    await POST(makeWebhookRequest());
    const foreignLog = mockApiLogger.warn.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a?.msg === "string" && a.msg.includes("checkout-session"));
    expect(foreignLog.msg).toContain("foreign-checkout-session-ignored");
    expect(foreignLog.metadataKeys).toEqual([]);

    vi.clearAllMocks();

    // Metadata PRESENT but carrying neither id — one of ours, broken. Someone
    // may have paid with nothing recorded, so this must NOT read as routine.
    const ours = makeStripeEvent("checkout.session.completed", {
      id: "cs_live_ours_broken",
      metadata: { organizationId: "org-1", eventId: "evt-1" },
      currency: "usd",
      amount_total: 10000,
      payment_intent: null,
      customer: null,
    });
    mockConstructEvent.mockReturnValue(ours);
    await POST(makeWebhookRequest());
    const oursLog = mockApiLogger.warn.mock.calls
      .map((c) => c[0])
      .find((a) => typeof a?.msg === "string" && a.msg.includes("metadata"));
    expect(oursLog.msg).toBe("Stripe checkout session missing registrationId metadata");
    expect(oursLog.msg).not.toContain("foreign");
    expect(oursLog.metadataKeys).toEqual(["organizationId", "eventId"]);
  });

  it("keeps BOTH at warn — neither is downgraded to info", async () => {
    for (const metadata of [{}, { eventId: "evt-1" }]) {
      vi.clearAllMocks();
      mockConstructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", {
          id: "cs_live_x",
          metadata,
          currency: "usd",
          amount_total: 100,
          payment_intent: null,
          customer: null,
        }),
      );
      await POST(makeWebhookRequest());
      expect(mockApiLogger.warn).toHaveBeenCalled();
      const infoMsgs = mockApiLogger.info.mock.calls
        .map((c) => c[0]?.msg)
        .filter((m) => typeof m === "string" && m.includes("checkout-session"));
      expect(infoMsgs).toEqual([]);
    }
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
        findUnique: vi.fn().mockResolvedValue({ paymentStatus: "PENDING", event: { organizationId: "org-1" } }),
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
      expect.objectContaining({ data: { paymentStatus: "PAID", stripeCheckoutSessionId: null, organizationId: "org-1" } })
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

// ── Tests: dispatcher expectedOrgId enforcement (review HIGH-1, Aug 4 2026) ──
//
// The per-org route passes { expectedOrgId } — a tenant's signing secret
// proves control of THEIR Stripe account only, so an event whose RESOLVED
// registration/payment belongs to a different org is refused before any
// write (acked 200 so a forged event never earns a Stripe retry storm).

describe("Dispatcher: expectedOrgId enforcement (HIGH-1)", () => {
  const foreignRegistration = {
    id: "reg-victim",
    paymentStatus: "UNPAID",
    status: "CONFIRMED",
    attendee: { firstName: "Vic", lastName: "Tim", email: "v@test.com", additionalEmail: null, title: null },
    ticketType: { name: "Standard", price: 150, currency: "USD" },
    pricingTier: null,
    event: { id: "evt-victim", organizationId: "org-victim", name: "Conf", slug: "conf", startDate: new Date(), venue: null, city: null, taxRate: 0, taxLabel: null },
  };

  const completedEvent = makeStripeEvent("checkout.session.completed", {
    id: "cs_forged",
    metadata: { registrationId: "reg-victim" },
    currency: "usd",
    amount_total: 100,
    payment_intent: "pi_forged",
    customer: null,
  }) as Parameters<typeof handleStripeEvent>[0];

  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ latest_charge: null });
  });

  it("checkout.session.completed resolving to ANOTHER org is refused: 200 ack + ignored + error log, ZERO writes", async () => {
    mockDb.registration.findUnique.mockResolvedValue(foreignRegistration);
    mockDb.payment.findUnique.mockResolvedValue(null);

    const res = await handleStripeEvent(completedEvent, { expectedOrgId: "org-attacker" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(mockApiLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining("cross-org-event-refused"),
        expectedOrgId: "org-attacker",
        resolvedOrgId: "org-victim",
      })
    );
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.payment.create).not.toHaveBeenCalled();
    expect(notifyEventAdmins).not.toHaveBeenCalled();
  });

  it("a MATCHING expectedOrgId passes the gate (reaches the idempotency check)", async () => {
    mockDb.registration.findUnique.mockResolvedValue(foreignRegistration);
    // Intent already recorded → the skip path proves we got PAST the org gate.
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-existing" });

    const res = await handleStripeEvent(completedEvent, { expectedOrgId: "org-victim" });
    expect(res.status).toBe(200);
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "Stripe webhook: payment intent already recorded, skipping" })
    );
    expect(mockApiLogger.error).not.toHaveBeenCalled();
  });

  it("NO expectedOrgId (the legacy env route) keeps today's behavior — no org gate", async () => {
    mockDb.registration.findUnique.mockResolvedValue(foreignRegistration);
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-existing" });

    const res = await handleStripeEvent(completedEvent);
    expect(res.status).toBe(200);
    expect(mockApiLogger.error).not.toHaveBeenCalled();
  });

  it("checkout.session.expired resolving to ANOTHER org is refused before the status reset", async () => {
    const expiredEvent = makeStripeEvent("checkout.session.expired", {
      id: "cs_forged",
      metadata: { registrationId: "reg-victim" },
    }) as Parameters<typeof handleStripeEvent>[0];
    mockDb.registration.findUnique.mockResolvedValue({ event: { organizationId: "org-victim" } });

    const res = await handleStripeEvent(expiredEvent, { expectedOrgId: "org-attacker" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("charge.refunded resolving to ANOTHER org is refused before any counter moves", async () => {
    const chargeEvent = makeStripeEvent("charge.refunded", {
      id: "ch_forged",
      payment_intent: "pi_victim",
      refunded: true,
      amount_refunded: 10000,
      currency: "usd",
    }) as Parameters<typeof handleStripeEvent>[0];
    mockDb.payment.findUnique.mockResolvedValue({
      id: "pay-victim",
      amount: 100,
      refundedAmount: 0,
      registrationId: "reg-victim",
      registration: {
        eventId: "evt-victim",
        refundedAmount: 0,
        attendee: { firstName: "Vic", lastName: "Tim" },
        event: { organizationId: "org-victim" },
      },
    });

    const res = await handleStripeEvent(chargeEvent, { expectedOrgId: "org-attacker" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: true });
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(issueCreditNoteSpy).not.toHaveBeenCalled();
  });
});
