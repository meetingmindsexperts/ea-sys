/**
 * Refund counters on a REAL Postgres (security audit W0-1, Nov 6, 2026).
 *
 * The charge.refunded webhook decides "already counted" from
 * Payment.refundedAmount alone, so the refund booking now raises that counter
 * in the same transaction as Registration.refundedAmount, before Stripe is
 * called, and every rollback brings both down together. The unit tests pin the
 * calls; a mocked Prisma cannot show that a throw inside the transaction really
 * undoes the write that ran before it. This does.
 *
 * Stripe is mocked (refunds.create / refunds.list); nothing here reaches it.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { refundsCreate, refundsList } = vi.hoisted(() => ({ refundsCreate: vi.fn(), refundsList: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: async () => ({ refunds: { create: refundsCreate, list: refundsList } }),
  toStripeAmount: (a: number) => Math.round(a * 100),
}));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import { db } from "@/lib/db";
import { createRegistration } from "@/services/registration-service";
import { refundRegistration } from "@/services/payment-service";
import { resolveStaleRefundAttempts } from "@/lib/refund-reconciliation";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;

/** A PAID registration with one Stripe payment of 100 and a full credit note. */
async function seedPaid() {
  const event = await db.event.create({
    data: {
      organizationId: seed.orgId,
      name: "Refund Event",
      slug: `refund-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-12-01"),
      endDate: new Date("2026-12-02"),
    },
    select: { id: true },
  });
  const type = await db.ticketType.create({
    data: { eventId: event.id, name: "Physician", price: 0, quantity: 100 },
    select: { id: true },
  });
  const created = await createRegistration({
    eventId: event.id,
    organizationId: seed.orgId,
    userId: seed.userId,
    ticketTypeId: type.id,
    attendee: { email: "refund@test.local", firstName: "Re", lastName: "Fund" },
    source: "rest",
  });
  if (!created.ok) throw new Error(created.code);
  const registrationId = created.registration.id;
  await db.registration.update({ where: { id: registrationId }, data: { paymentStatus: "PAID" } });
  const payment = await db.payment.create({
    data: { registrationId, organizationId: seed.orgId, amount: 100, currency: "USD", status: "PAID", stripePaymentId: `pi_${registrationId}` },
    select: { id: true },
  });
  await db.invoice.create({
    data: {
      organizationId: seed.orgId, eventId: event.id, registrationId,
      type: "CREDIT_NOTE", invoiceNumber: `CN-${registrationId}`, sequenceNumber: 1,
      status: "SENT", subtotal: 100, total: 100, currency: "USD",
    },
  });
  return { eventId: event.id, registrationId, paymentId: payment.id };
}

async function counters(registrationId: string, paymentId: string) {
  const [reg, pay] = await Promise.all([
    db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { refundedAmount: true, paymentStatus: true } }),
    db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmount: true, status: true } }),
  ]);
  return {
    reg: Number(reg.refundedAmount), regStatus: reg.paymentStatus,
    pay: Number(pay.refundedAmount), payStatus: pay.status,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  seed = await resetCrm();
});

// Fire-and-forget writes (audit rows) must land before the next reset truncates.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 200));
});

describe("refund booking moves both counters together", () => {
  it("a successful partial refund: both counters at 30 when Stripe is called, and after", async () => {
    const { eventId, registrationId, paymentId } = await seedPaid();
    let atStripe: Awaited<ReturnType<typeof counters>> | null = null;
    refundsCreate.mockImplementation(async () => {
      // What a charge.refunded webhook would read if it landed right now.
      atStripe = await counters(registrationId, paymentId);
      return { id: "re_1" };
    });

    const r = await refundRegistration({ registrationId, eventId, amount: 30, source: "rest" });
    expect(r.ok).toBe(true);
    expect(atStripe).toMatchObject({ reg: 30, pay: 30 });
    expect(await counters(registrationId, paymentId)).toEqual({ reg: 30, regStatus: "PAID", pay: 30, payStatus: "PAID" });
  });

  it("Stripe provably did not refund: both counters and both statuses come back", async () => {
    const { eventId, registrationId, paymentId } = await seedPaid();
    refundsCreate.mockRejectedValue(new Error("card_declined"));
    refundsList.mockResolvedValue({ data: [] });

    const r = await refundRegistration({ registrationId, eventId, source: "rest" }); // full 100
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    expect(await counters(registrationId, paymentId)).toEqual({ reg: 0, regStatus: "PAID", pay: 0, payStatus: "PAID" });
  });
});

describe("the sweep's rollback is all or nothing", () => {
  async function staleAttempt(registrationId: string, paymentId: string, amount: number) {
    return db.refundAttempt.create({
      data: {
        organizationId: seed.orgId, registrationId, paymentId, stripePaymentIntentId: `pi_${registrationId}`,
        amount, refundedBefore: 0, refundedAfter: amount, kind: "stripe", status: "PENDING", source: "rest",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
      select: { id: true },
    });
  }

  it("a crash before Stripe (both counters booked, no refund): the sweep brings both down", async () => {
    const { registrationId, paymentId } = await seedPaid();
    await db.registration.update({ where: { id: registrationId }, data: { refundedAmount: 40 } });
    await db.payment.update({ where: { id: paymentId }, data: { refundedAmount: 40 } });
    await staleAttempt(registrationId, paymentId, 40);
    refundsList.mockResolvedValue({ data: [] });

    expect(await resolveStaleRefundAttempts()).toMatchObject({ rolledBack: 1 });
    expect(await counters(registrationId, paymentId)).toMatchObject({ reg: 0, pay: 0 });
  });

  it("the payment decrement cannot apply: the registration decrement that ran first is undone too", async () => {
    const { registrationId, paymentId } = await seedPaid();
    // A pre-fix row: the registration was booked, the payment counter never was.
    await db.registration.update({ where: { id: registrationId }, data: { refundedAmount: 40 } });
    const attempt = await staleAttempt(registrationId, paymentId, 40);
    refundsList.mockResolvedValue({ data: [] });

    expect(await resolveStaleRefundAttempts()).toMatchObject({ needsReview: 1, rolledBack: 0 });
    // Nothing half-applied: the registration still says 40, for a human to settle.
    expect(await counters(registrationId, paymentId)).toMatchObject({ reg: 40, pay: 0 });
    const row = await db.refundAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true } });
    expect(row.status).toBe("FAILED");
  });
});
