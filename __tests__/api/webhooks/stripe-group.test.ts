/**
 * Group settlement webhook branches (group registration Phase 2).
 *
 * The properties worth pinning are the ones that differ from the
 * single-registration path and would be silently wrong if a future refactor
 * treated a group like a big registration:
 *   - ONE Payment row anchored to the GROUP (registrationId null)
 *   - N registrations flip together, scoped to the group
 *   - a refund NEVER auto-flips members (owner ruling: alert, reconcile by hand)
 *   - abandonment releases only the members THIS session parked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockStripeInstance } = vi.hoisted(() => ({
  mockDb: {
    registrationGroup: { findUnique: vi.fn() },
    registration: { updateMany: vi.fn() },
    payment: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockStripeInstance: {
    paymentIntents: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
  },
}));

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
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(async () => mockStripeInstance),
  fromStripeAmount: vi.fn((amount: number, currency: string) =>
    ["JPY", "KRW"].includes(currency.toUpperCase()) ? amount : amount / 100,
  ),
}));
vi.mock("@/lib/notifications", () => ({
  notifyEventAdmins: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/invoice-service", () => ({
  issuePaidRegistrationDocuments: vi.fn().mockResolvedValue(undefined),
  issuePaidGroupDocuments: vi.fn().mockResolvedValue({ invoice: null, promoted: true }),
}));
vi.mock("@/services/payment-service", () => ({
  issueCreditNoteForRegistration: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/stripe-receipt", () => ({
  captureStripeReceipt: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registration-financials", () => ({
  computeRegistrationFinancials: vi.fn(() => ({ total: 0 })),
  readRegistrationBasePrice: vi.fn(() => 0),
  round2: (n: number) => Math.round(n * 100) / 100,
}));

import { handleStripeEvent } from "@/lib/stripe-webhook-handler";
import { notifyEventAdmins } from "@/lib/notifications";
import { issuePaidGroupDocuments } from "@/lib/invoice-service";

type StripeEventLike = Parameters<typeof handleStripeEvent>[0];

const GROUP = {
  id: "grp-1",
  coordinatorName: "Layla Hassan",
  event: { id: "evt-1", organizationId: "org-1", name: "BigSky 2027" },
  billingAccount: { name: "Gulf Heart Institute" },
  registrations: [
    { id: "reg-1", paymentStatus: "UNPAID" },
    { id: "reg-2", paymentStatus: "UNPAID" },
    { id: "reg-3", paymentStatus: "UNPAID" },
  ],
};

function completedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_grp_1",
        currency: "usd",
        amount_total: 105000,
        payment_intent: "pi_grp_1",
        customer: "cus_1",
        metadata: { groupId: "grp-1", eventId: "evt-1", organizationId: "org-1" },
        ...overrides,
      },
    },
  } as unknown as StripeEventLike;
}

/** Run the interactive tx against a proxy that records the writes. */
function wireTransaction() {
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      registration: mockDb.registration,
      payment: mockDb.payment,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  wireTransaction();
  mockDb.registrationGroup.findUnique.mockResolvedValue(GROUP);
  mockDb.payment.findUnique.mockResolvedValue(null);
  mockDb.registration.updateMany.mockResolvedValue({ count: 3 });
  mockDb.payment.create.mockResolvedValue({ id: "pay-1" });
  mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ latest_charge: "ch_1" });
  mockStripeInstance.charges.retrieve.mockResolvedValue({
    receipt_url: "https://stripe.test/r",
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    created: 1770000000,
  });
});

describe("group checkout.session.completed", () => {
  it("records ONE payment anchored to the group, not per member", async () => {
    const res = await handleStripeEvent(completedEvent());
    expect(res.status).toBe(200);

    expect(mockDb.payment.create).toHaveBeenCalledTimes(1);
    const data = mockDb.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      groupId: "grp-1",
      registrationId: null,
      organizationId: "org-1",
      amount: 1050,
      currency: "USD",
      stripePaymentId: "pi_grp_1",
      status: "PAID",
      cardBrand: "visa",
      cardLast4: "4242",
    });
  });

  it("flips every payable member of THAT group in one scoped write", async () => {
    await handleStripeEvent(completedEvent());
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: {
        groupId: "grp-1",
        status: { not: "CANCELLED" },
        paymentStatus: { in: ["UNPAID", "PENDING"] },
      },
      data: { paymentStatus: "PAID", stripeCheckoutSessionId: null },
    });
  });

  it("promotes the consolidated invoice rather than minting a second document", async () => {
    await handleStripeEvent(completedEvent());
    expect(issuePaidGroupDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "grp-1",
        eventId: "evt-1",
        organizationId: "org-1",
        paymentId: "pay-1",
      }),
    );
  });

  it("is idempotent on the charge: a retry writes nothing", async () => {
    mockDb.payment.findUnique.mockResolvedValue({ id: "pay-existing" });
    const res = await handleStripeEvent(completedEvent());
    expect(res.status).toBe(200);
    expect(mockDb.payment.create).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(issuePaidGroupDocuments).not.toHaveBeenCalled();
  });

  it("an already-settled group still books the money but sends no second invoice", async () => {
    mockDb.registrationGroup.findUnique.mockResolvedValue({
      ...GROUP,
      registrations: GROUP.registrations.map((r) => ({ ...r, paymentStatus: "PAID" })),
    });
    const res = await handleStripeEvent(completedEvent());
    expect(res.status).toBe(200);
    // Money truth: the charge is recorded...
    expect(mockDb.payment.create).toHaveBeenCalledTimes(1);
    // ...but members aren't re-flipped and no paid invoice goes out.
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(issuePaidGroupDocuments).not.toHaveBeenCalled();
    expect(notifyEventAdmins).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: expect.stringContaining("double payment") }),
    );
  });

  it("refuses a cross-org event on the per-org endpoint before any write", async () => {
    const res = await handleStripeEvent(completedEvent(), { expectedOrgId: "org-OTHER" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(mockDb.payment.create).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("alerts admins when the money landed but the invoice could not be issued", async () => {
    vi.mocked(issuePaidGroupDocuments).mockRejectedValueOnce(new Error("pdf boom"));
    const res = await handleStripeEvent(completedEvent());
    // Still acked: the charge settled, a retry would only skip.
    expect(res.status).toBe(200);
    expect(notifyEventAdmins).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ title: expect.stringContaining("invoice not issued") }),
    );
  });

  it("an unknown group is acked, not retried forever", async () => {
    mockDb.registrationGroup.findUnique.mockResolvedValue(null);
    const res = await handleStripeEvent(completedEvent());
    expect(res.status).toBe(200);
    expect(mockDb.payment.create).not.toHaveBeenCalled();
  });
});

describe("group checkout.session.expired", () => {
  it("releases only the members THIS session parked at PENDING", async () => {
    mockDb.registration.updateMany.mockResolvedValue({ count: 3 });
    const res = await handleStripeEvent({
      type: "checkout.session.expired",
      data: {
        object: {
          id: "cs_grp_1",
          metadata: { groupId: "grp-1", organizationId: "org-1" },
        },
      },
    } as unknown as StripeEventLike);

    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: {
        groupId: "grp-1",
        paymentStatus: "PENDING",
        // Scoped to this session so a second open tab's claim survives.
        stripeCheckoutSessionId: "cs_grp_1",
      },
      data: { paymentStatus: "UNPAID", stripeCheckoutSessionId: null },
    });
  });
});

describe("group charge.refunded", () => {
  const GROUP_PAYMENT = {
    id: "pay-1",
    amount: 1050,
    currency: "USD",
    refundedAmount: 0,
    registrationId: null,
    groupId: "grp-1",
    registration: null,
    group: {
      id: "grp-1",
      coordinatorName: "Layla Hassan",
      eventId: "evt-1",
      billingAccount: { name: "Gulf Heart Institute" },
      event: { organizationId: "org-1" },
      _count: { registrations: 3 },
    },
  };

  function refundEvent(amountRefunded: number) {
    return {
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: "pi_grp_1",
          amount_refunded: amountRefunded,
          currency: "usd",
          created: 1770000000,
        },
      },
    } as unknown as StripeEventLike;
  }

  beforeEach(() => {
    mockDb.payment.findUnique.mockResolvedValue(GROUP_PAYMENT);
    mockDb.payment.updateMany.mockResolvedValue({ count: 1 });
  });

  it("NEVER auto-flips member registrations (owner ruling: reconcile by hand)", async () => {
    const res = await handleStripeEvent(refundEvent(105000));
    expect(res.status).toBe(200);
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("records the refund against the group payment and marks it REFUNDED when full", async () => {
    await handleStripeEvent(refundEvent(105000));
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: { lt: 1050 } },
      data: { refundedAmount: 1050, status: "REFUNDED" },
    });
  });

  it("a partial refund leaves the payment PAID", async () => {
    await handleStripeEvent(refundEvent(30000));
    expect(mockDb.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", refundedAmount: { lt: 300 } },
      data: { refundedAmount: 300, status: "PAID" },
    });
  });

  it("alerts admins that members are still marked paid", async () => {
    await handleStripeEvent(refundEvent(105000));
    expect(notifyEventAdmins).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({
        message: expect.stringContaining("STILL marked paid"),
      }),
    );
  });

  it("is idempotent: a redelivered refund cannot double-count", async () => {
    mockDb.payment.updateMany.mockResolvedValue({ count: 0 });
    const res = await handleStripeEvent(refundEvent(105000));
    expect(res.status).toBe(200);
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining("group-already-reconciled"),
      }),
    );
  });

  it("refuses a cross-org refund on the per-org endpoint", async () => {
    const res = await handleStripeEvent(refundEvent(105000), { expectedOrgId: "org-OTHER" });
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled();
  });
});
