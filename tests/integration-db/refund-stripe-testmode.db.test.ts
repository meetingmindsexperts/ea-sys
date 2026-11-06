/**
 * Refunds against Stripe's REAL test mode and a real Postgres (security audit
 * W0-1 follow-up, Nov 6, 2026). OPT-IN: skipped unless
 * STRIPE_TESTMODE_SECRET_KEY holds an sk_test_ key, so CI never calls Stripe.
 *
 * refund-counters.db.test.ts covers every ordering with a stateful fake; this
 * checks the fake's assumptions against the real thing: that refunds.list
 * reports what was refunded and which attempt made it, that Stripe refuses a
 * refund past what is left on the charge, and that the real charge object's
 * amount_refunded is what the webhook reconciles against.
 *
 * Run: INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test \
 *      STRIPE_TESTMODE_SECRET_KEY=sk_test_... npx vitest run -c vitest.config.integration-db.ts \
 *      tests/integration-db/refund-stripe-testmode.db.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";

const KEY = process.env.STRIPE_TESTMODE_SECRET_KEY ?? "";
const enabled = KEY.startsWith("sk_test_");

vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn(), sendEmail: vi.fn(), sendInvoiceEmailMessage: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/stripe-receipt", () => ({ captureStripeReceipt: vi.fn(async () => undefined) }));

import Stripe from "stripe";
import { db } from "@/lib/db";
import { createRegistration } from "@/services/registration-service";
import { refundRegistration } from "@/services/payment-service";
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;
let stripe: Stripe;

beforeAll(() => {
  if (!enabled) return;
  // Never a live key: the guard above, and the app's own client reads this.
  process.env.STRIPE_SECRET_KEY = KEY;
  stripe = new Stripe(KEY);
});

beforeEach(async () => {
  if (!enabled) return;
  seed = await resetCrm();
  // The seeded org has no key of its own; let it use the test key.
  process.env.STRIPE_ENV_FALLBACK_ORG_ID = seed.orgId;
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 300));
});

/** A real, captured 120.00 USD test-mode charge, and a PAID registration for it. */
async function seedPaid(credited: number) {
  const pi = await stripe.paymentIntents.create({
    amount: 12000, currency: "usd", payment_method: "pm_card_visa", payment_method_types: ["card"], confirm: true,
    metadata: { purpose: "ea-sys refund integration test" },
  });
  expect(pi.status).toBe("succeeded");
  const event = await db.event.create({
    data: {
      organizationId: seed.orgId, name: "Stripe Test Event",
      slug: `stripe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-12-01"), endDate: new Date("2026-12-02"),
    },
    select: { id: true },
  });
  const type = await db.ticketType.create({ data: { eventId: event.id, name: "Physician", price: 0, quantity: 100 }, select: { id: true } });
  const created = await createRegistration({
    eventId: event.id, organizationId: seed.orgId, userId: seed.userId, ticketTypeId: type.id,
    attendee: { email: `stripe-${Math.random().toString(36).slice(2, 8)}@test.local`, firstName: "Test", lastName: "Mode" },
    source: "rest",
  });
  if (!created.ok) throw new Error(created.code);
  const registrationId = created.registration.id;
  await db.registration.update({ where: { id: registrationId }, data: { paymentStatus: "PAID" } });
  const payment = await db.payment.create({
    data: { registrationId, organizationId: seed.orgId, amount: 120, currency: "USD", status: "PAID", stripePaymentId: pi.id },
    select: { id: true },
  });
  await db.invoice.create({
    data: {
      organizationId: seed.orgId, eventId: event.id, registrationId, type: "CREDIT_NOTE",
      invoiceNumber: `CN-${registrationId}`, sequenceNumber: 1, status: "SENT", subtotal: credited, total: credited, currency: "USD",
    },
  });
  // The app numbers documents from this counter; without it the next credit
  // note would take sequence 1 again and collide with the seeded one.
  await db.invoiceCounter.create({ data: { eventId: event.id, type: "CREDIT_NOTE", lastSequence: 1 } });
  return { eventId: event.id, registrationId, paymentId: payment.id, intent: pi.id };
}

/** charge.refunded built from Stripe's REAL charge, delivered to the real handler. */
async function deliverChargeRefunded(intent: string) {
  const pi = await stripe.paymentIntents.retrieve(intent);
  const charge = await stripe.charges.retrieve(pi.latest_charge as string);
  const res = await handleStripeEvent({ id: `evt_test_${Date.now()}`, type: "charge.refunded", data: { object: charge } } as unknown as Stripe.Event);
  await new Promise((r) => setTimeout(r, 300));
  return res.status;
}

async function stripeRefunded(intent: string) {
  const pi = await stripe.paymentIntents.retrieve(intent);
  const charge = await stripe.charges.retrieve(pi.latest_charge as string);
  return charge.amount_refunded / 100;
}

async function books(registrationId: string, paymentId: string) {
  const [reg, pay] = await Promise.all([
    db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { refundedAmount: true, paymentStatus: true } }),
    db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmount: true, status: true } }),
  ]);
  return { reg: Number(reg.refundedAmount), pay: Number(pay.refundedAmount), regStatus: reg.paymentStatus, payStatus: pay.status };
}

describe.skipIf(!enabled)("refunds against Stripe test mode", () => {
  it("a partial refund, then its real webhook: counted once, books equal Stripe", async () => {
    const { eventId, registrationId, paymentId, intent } = await seedPaid(120);
    const r = await refundRegistration({ registrationId, eventId, amount: 30, source: "rest" });
    expect(r).toMatchObject({ ok: true });
    expect(await deliverChargeRefunded(intent)).toBe(200);
    expect(await books(registrationId, paymentId)).toMatchObject({ reg: 30, pay: 30, regStatus: "PAID" });
    expect(await stripeRefunded(intent)).toBe(30);
    // The attempt is tagged on the real refund, which is what the sweep relies on.
    const refunds = await stripe.refunds.list({ payment_intent: intent });
    const attempt = await db.refundAttempt.findFirstOrThrow({ where: { registrationId }, select: { id: true } });
    expect(refunds.data.map((x) => x.metadata?.refundAttemptId)).toContain(attempt.id);
  });

  it("MED-1 for real: a Dashboard refund our books have not seen, then ours is refused by Stripe; the books end equal to Stripe", async () => {
    const { eventId, registrationId, paymentId, intent } = await seedPaid(80);
    // The "Dashboard" refund: made at Stripe directly, its webhook not delivered yet.
    await stripe.refunds.create({ payment_intent: intent, amount: 5000 });
    // Ours asks for 80; only 70 is left on the charge, so Stripe refuses it.
    const r = await refundRegistration({ registrationId, eventId, amount: 80, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    await new Promise((res) => setTimeout(res, 500));
    expect(await books(registrationId, paymentId)).toMatchObject({ reg: 50, pay: 50, regStatus: "PAID", payStatus: "PAID" });
    // The late webhook for the Dashboard refund now finds nothing new.
    expect(await deliverChargeRefunded(intent)).toBe(200);
    expect(await books(registrationId, paymentId)).toMatchObject({ reg: 50, pay: 50 });
    expect(await stripeRefunded(intent)).toBe(50);
    // Its credit note cannot be added: the note for our refused 80 already
    // credits 80 of the 120, and 80 + 50 is past the paid total. Same cap as the
    // webhook's; the organisers are told to settle the notes by hand.
    expect(await db.invoice.count({ where: { registrationId, type: "CREDIT_NOTE" } })).toBe(1);
    const { notifyEventAdmins } = await import("@/lib/notifications");
    expect(notifyEventAdmins).toHaveBeenCalledWith(eventId, expect.objectContaining({ title: "⚠ Credit note could not be recorded for a Stripe refund" }));
  });

  it("a full refund in two parts, the second completing it: REFUNDED on both, equal to Stripe", async () => {
    const { eventId, registrationId, paymentId, intent } = await seedPaid(120);
    expect((await refundRegistration({ registrationId, eventId, amount: 20, source: "rest" })).ok).toBe(true);
    await deliverChargeRefunded(intent);
    expect((await refundRegistration({ registrationId, eventId, source: "rest" })).ok).toBe(true);
    await deliverChargeRefunded(intent);
    expect(await books(registrationId, paymentId)).toMatchObject({ reg: 120, pay: 120, regStatus: "REFUNDED", payStatus: "REFUNDED" });
    expect(await stripeRefunded(intent)).toBe(120);
  });
});
