/**
 * Refund counters on a REAL Postgres (security audit W0-1, Nov 6, 2026).
 *
 * The charge.refunded webhook decides "already counted" from
 * Payment.refundedAmount alone. The refund booking raises that counter with
 * Registration.refundedAmount before Stripe is called, and every rollback goes
 * through src/services/refund-unbook.ts, which sets a Stripe payment's counter
 * from Stripe's own figure. These run the real service, the real sweep and the
 * REAL webhook handler against a real database, with a small stateful fake of
 * Stripe, so a Dashboard refund or a webhook can be slipped in at the exact
 * moment that matters. Every scenario ends by checking the books against the
 * fake Stripe's own ledger.
 *
 * The same flows against Stripe's real test mode: refund-stripe-testmode.db.test.ts.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── A stateful fake of the slice of Stripe the refund paths use ─────────────
type FakeRefund = { id: string; amount: number; status: string; currency: string; metadata: Record<string, string> };
const { fake } = vi.hoisted(() => ({
  fake: {
    charges: new Map<string, number>(), // intent → charged amount (minor units)
    refunds: new Map<string, FakeRefund[]>(),
    seq: 0,
    /** Runs inside refunds.create BEFORE it decides; may add refunds or deliver webhooks. */
    beforeCreate: null as null | ((intent: string) => Promise<void>),
    /** When set, refunds.create throws this after (optionally) recording the refund. */
    createError: null as null | { err: Error; recordAnyway: boolean },
    listError: null as null | Error,
    /** Runs right AFTER refunds.list answered: the moment between our Stripe read and our rollback. */
    afterList: null as null | ((intent: string) => Promise<void>),
  },
}));
function refundedMinor(intent: string) {
  return (fake.refunds.get(intent) ?? []).filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amount, 0);
}
function addRefund(intent: string, amount: number, metadata: Record<string, string> = {}) {
  const r = { id: `re_${++fake.seq}`, amount, status: "succeeded", currency: "usd", metadata };
  fake.refunds.set(intent, [...(fake.refunds.get(intent) ?? []), r]);
  return r;
}
vi.mock("@/lib/stripe", () => ({
  getStripe: async () => ({
    refunds: {
      create: async (params: { payment_intent: string; amount: number; metadata: Record<string, string> }) => {
        if (fake.beforeCreate) await fake.beforeCreate(params.payment_intent);
        if (fake.createError) {
          if (fake.createError.recordAnyway) addRefund(params.payment_intent, params.amount, params.metadata);
          throw fake.createError.err;
        }
        // What Stripe does: a refund past the charge's remaining balance is refused.
        if (refundedMinor(params.payment_intent) + params.amount > (fake.charges.get(params.payment_intent) ?? 0)) {
          throw new Error("Refund amount is greater than unrefunded amount on charge");
        }
        return addRefund(params.payment_intent, params.amount, params.metadata);
      },
      list: async ({ payment_intent }: { payment_intent: string }) => {
        if (fake.listError) throw fake.listError;
        const answer = { data: [...(fake.refunds.get(payment_intent) ?? [])], has_more: false };
        if (fake.afterList) {
          const hook = fake.afterList;
          fake.afterList = null;
          await hook(payment_intent);
        }
        return answer;
      },
    },
  }),
  toStripeAmount: (a: number) => Math.round(a * 100),
  fromStripeAmount: (a: number) => a / 100,
}));
vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn(), sendEmail: vi.fn(), sendInvoiceEmailMessage: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/stripe-receipt", () => ({ captureStripeReceipt: vi.fn(async () => undefined) }));

import type Stripe from "stripe";
import { db } from "@/lib/db";
import { createRegistration } from "@/services/registration-service";
import { refundRegistration } from "@/services/payment-service";
import { resolveStaleRefundAttempts } from "@/lib/refund-reconciliation";
import { unbookRefund, UnbookAttemptMoved } from "@/services/refund-unbook";
import { tenantTransaction } from "@/lib/db";
import { handleStripeEvent } from "@/lib/stripe-webhook-handler";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;

/** Delivers charge.refunded for an intent exactly as Stripe would, now. */
async function deliverChargeRefunded(intent: string) {
  const event = {
    id: `evt_${++fake.seq}`,
    type: "charge.refunded",
    data: { object: { id: `ch_${intent}`, payment_intent: intent, amount_refunded: refundedMinor(intent), currency: "usd", created: Math.floor(Date.now() / 1000) } },
  } as unknown as Stripe.Event;
  const res = await handleStripeEvent(event);
  // Let its fire-and-forget credit note land.
  await new Promise((r) => setTimeout(r, 150));
  return res.status;
}

/** A PAID registration with the given payments and a credit note. Amounts in display units. */
async function seedPaid(opts: { payments: Array<{ amount: number; stripe: boolean }>; credited: number }) {
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
  const type = await db.ticketType.create({ data: { eventId: event.id, name: "Physician", price: 0, quantity: 100 }, select: { id: true } });
  const created = await createRegistration({
    eventId: event.id, organizationId: seed.orgId, userId: seed.userId, ticketTypeId: type.id,
    attendee: { email: `refund-${Math.random().toString(36).slice(2, 8)}@test.local`, firstName: "Re", lastName: "Fund" },
    source: "rest",
  });
  if (!created.ok) throw new Error(created.code);
  const registrationId = created.registration.id;
  await db.registration.update({ where: { id: registrationId }, data: { paymentStatus: "PAID" } });
  const paymentIds: string[] = [];
  const intents: string[] = [];
  for (const [i, p] of opts.payments.entries()) {
    const intent = p.stripe ? `pi_${registrationId}_${i}` : null;
    if (intent) {
      fake.charges.set(intent, Math.round(p.amount * 100));
      intents.push(intent);
    }
    const row = await db.payment.create({
      data: { registrationId, organizationId: seed.orgId, amount: p.amount, currency: "USD", status: "PAID", stripePaymentId: intent, createdAt: new Date(Date.now() - (10 - i) * 1000) },
      select: { id: true },
    });
    paymentIds.push(row.id);
  }
  await db.invoice.create({
    data: {
      organizationId: seed.orgId, eventId: event.id, registrationId, type: "CREDIT_NOTE",
      invoiceNumber: `CN-${registrationId}`, sequenceNumber: 1, status: "SENT",
      subtotal: opts.credited, total: opts.credited, currency: "USD",
    },
  });
  // The app numbers documents from this counter; without it the next credit
  // note would take sequence 1 again and collide with the seeded one.
  await db.invoiceCounter.create({ data: { eventId: event.id, type: "CREDIT_NOTE", lastSequence: 1 } });
  return { eventId: event.id, registrationId, paymentIds, intents };
}

async function books(registrationId: string) {
  const [reg, payments, notes] = await Promise.all([
    db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { refundedAmount: true, paymentStatus: true } }),
    db.payment.findMany({ where: { registrationId }, orderBy: { createdAt: "asc" }, select: { refundedAmount: true, status: true, stripePaymentId: true } }),
    db.invoice.count({ where: { registrationId, type: "CREDIT_NOTE" } }),
  ]);
  return {
    reg: Number(reg.refundedAmount),
    regStatus: reg.paymentStatus,
    pay: payments.map((p) => Number(p.refundedAmount)),
    payStatus: payments.map((p) => p.status),
    creditNotes: notes,
  };
}

/** The invariant: every Stripe payment's counter equals what Stripe holds. */
async function expectStripeCountersMatch(registrationId: string) {
  const payments = await db.payment.findMany({ where: { registrationId, stripePaymentId: { not: null } }, select: { stripePaymentId: true, refundedAmount: true } });
  for (const p of payments) expect(Number(p.refundedAmount)).toBe(refundedMinor(p.stripePaymentId!) / 100);
}

/** The sweep takes attempts untouched for 10 minutes; make them so. */
async function ageAttempts(registrationId: string) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await db.refundAttempt.updateMany({ where: { registrationId }, data: { createdAt: hourAgo, updatedAt: hourAgo } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fake.charges.clear();
  fake.refunds.clear();
  fake.beforeCreate = null;
  fake.createError = null;
  fake.listError = null;
  fake.afterList = null;
  seed = await resetCrm();
});

// Fire-and-forget writes (audit rows, credit notes) must land before the next reset truncates.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 250));
});

describe("the original bug: our own refund's webhook", () => {
  it("webhook delivered DURING our Stripe call (the race) books nothing a second time", async () => {
    const { eventId, registrationId, intents } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    // Stripe records the refund and fires charge.refunded before our call returns.
    let during = 0;
    fake.beforeCreate = async (intent) => {
      fake.beforeCreate = null;
      addRefund(intent, 3000, { refundAttemptId: "elsewhere" });
      during = await deliverChargeRefunded(intent);
      // Undo the stand-in; the real create below records ours.
      fake.refunds.set(intent, []);
    };
    const r = await refundRegistration({ registrationId, eventId, amount: 30, source: "rest" });
    expect(r.ok).toBe(true);
    // Our refund was in flight, so that delivery was refused (Stripe redelivers)...
    expect(during).toBe(500);
    // ...and the real webhook for our refund, after.
    expect(await deliverChargeRefunded(intents[0])).toBe(200);
    expect(await books(registrationId)).toMatchObject({ reg: 30, pay: [30], regStatus: "PAID", creditNotes: 1 });
    await expectStripeCountersMatch(registrationId);
  });

  it("the process dies after Stripe succeeded: the sweep confirms, the webhook books nothing extra", async () => {
    const { eventId, registrationId, intents } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    fake.createError = { err: new Error("socket hang up"), recordAnyway: true };
    fake.listError = new Error("still unreachable");
    const r = await refundRegistration({ registrationId, eventId, amount: 40, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });

    fake.listError = null;
    await ageAttempts(registrationId);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ confirmed: 1, rolledBack: 0 });
    expect(await deliverChargeRefunded(intents[0])).toBe(200);
    expect(await books(registrationId)).toMatchObject({ reg: 40, pay: [40], creditNotes: 1 });
    await expectStripeCountersMatch(registrationId);
  });

  it("a redelivered webhook changes nothing", async () => {
    const { eventId, registrationId, intents } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    expect((await refundRegistration({ registrationId, eventId, amount: 25, source: "rest" })).ok).toBe(true);
    await deliverChargeRefunded(intents[0]);
    await deliverChargeRefunded(intents[0]);
    expect(await books(registrationId)).toMatchObject({ reg: 25, pay: [25], creditNotes: 1 });
  });
});

describe("MED-1: a Stripe Dashboard refund while ours is booked", () => {
  it("its webhook skipped it, then ours failed: the books keep the Dashboard 50 and get its credit note", async () => {
    const { eventId, registrationId } = await seedPaid({ payments: [{ amount: 120, stripe: true }], credited: 60 });
    fake.beforeCreate = async (intent) => {
      fake.beforeCreate = null;
      addRefund(intent, 5000); // the Dashboard refund
      await deliverChargeRefunded(intent); // sees counter 60 ≥ 50: skips
      // Ours (60) now exceeds what is left on 120 after 50? No: 110 ≤ 120. Make it fail outright.
      fake.createError = { err: new Error("card_declined"), recordAnyway: false };
    };
    const r = await refundRegistration({ registrationId, eventId, amount: 60, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    await new Promise((res) => setTimeout(res, 300));
    expect(await books(registrationId)).toMatchObject({ reg: 50, pay: [50], regStatus: "PAID", creditNotes: 2 });
    await expectStripeCountersMatch(registrationId);
  });

  it("its webhook booked part of it (Dashboard 70, counter set to 70), then ours failed: books keep 70", async () => {
    const { eventId, registrationId } = await seedPaid({ payments: [{ amount: 120, stripe: true }], credited: 60 });
    fake.beforeCreate = async (intent) => {
      fake.beforeCreate = null;
      addRefund(intent, 7000);
      await deliverChargeRefunded(intent); // delta 70 - 60 = 10 booked, counter := 70
    };
    // 70 + 60 > 120: Stripe refuses ours.
    const r = await refundRegistration({ registrationId, eventId, amount: 60, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    await new Promise((res) => setTimeout(res, 300));
    expect(await books(registrationId)).toMatchObject({ reg: 70, pay: [70] });
    await expectStripeCountersMatch(registrationId);
  });

  it("its webhook had not arrived when ours failed: the books go up to it, and the late webhook adds nothing", async () => {
    const { eventId, registrationId, intents } = await seedPaid({ payments: [{ amount: 120, stripe: true }], credited: 60 });
    fake.beforeCreate = async (intent) => {
      fake.beforeCreate = null;
      addRefund(intent, 7000); // no webhook yet
    };
    const r = await refundRegistration({ registrationId, eventId, amount: 60, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    await new Promise((res) => setTimeout(res, 300));
    const before = await books(registrationId);
    expect(before).toMatchObject({ reg: 70, pay: [70] });
    expect(await deliverChargeRefunded(intents[0])).toBe(200);
    expect(await books(registrationId)).toEqual(before);
    await expectStripeCountersMatch(registrationId);
  });
});

describe("MED-2: a rollback that cannot apply strands nothing", () => {
  it("two Stripe payments and a manual one; Stripe unreachable mid-refund; the sweep later takes every slice back", async () => {
    const { eventId, registrationId } = await seedPaid({
      payments: [{ amount: 50, stripe: true }, { amount: 100, stripe: true }, { amount: 30, stripe: false }],
      credited: 180,
    });
    // The first Stripe call times out and nothing can be verified.
    fake.createError = { err: new Error("ETIMEDOUT"), recordAnyway: false };
    fake.listError = new Error("unreachable");
    const r = await refundRegistration({ registrationId, eventId, source: "rest" }); // full 180
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    const attempts = await db.refundAttempt.findMany({ where: { registrationId }, select: { status: true, kind: true } });
    expect(attempts.map((a) => a.status).sort()).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"]);

    fake.createError = null;
    fake.listError = null;
    await ageAttempts(registrationId);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ rolledBack: 3, needsReview: 0 });
    expect(await books(registrationId)).toMatchObject({ reg: 0, pay: [0, 0, 0], regStatus: "PAID", payStatus: ["PAID", "PAID", "PAID"] });
  });

  it("...and when the first slice DID go through at Stripe, the sweep keeps it and takes back only the rest", async () => {
    const { eventId, registrationId } = await seedPaid({
      payments: [{ amount: 50, stripe: true }, { amount: 100, stripe: true }, { amount: 30, stripe: false }],
      credited: 180,
    });
    fake.createError = { err: new Error("ETIMEDOUT"), recordAnyway: true };
    fake.listError = new Error("unreachable");
    await refundRegistration({ registrationId, eventId, source: "rest" });

    fake.createError = null;
    fake.listError = null;
    await ageAttempts(registrationId);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ confirmed: 1, rolledBack: 2 });
    // The newest payment is refunded first; which one that is does not matter, the ledger decides.
    const b = await books(registrationId);
    expect(b.reg).toBe(b.pay.reduce((s, x) => s + x, 0));
    expect(b.pay[2]).toBe(0); // the manual one never moved
    await expectStripeCountersMatch(registrationId);
  });
});

describe("review 2: races between the refund, the sweep and the webhook", () => {
  it("MED-2: a Dashboard refund lands between our Stripe read and our rollback; its webhook 500s, the redelivery books it", async () => {
    const { eventId, registrationId, intents } = await seedPaid({ payments: [{ amount: 120, stripe: true }], credited: 60 });
    let firstDelivery = 0;
    fake.createError = { err: new Error("card_declined"), recordAnyway: false };
    // Our verify read says "nothing at Stripe"; THEN the Dashboard refund lands
    // and its webhook arrives, all before our rollback transaction.
    fake.afterList = async (intent) => {
      addRefund(intent, 4000);
      firstDelivery = await deliverChargeRefunded(intent);
    };
    const r = await refundRegistration({ registrationId, eventId, amount: 60, source: "rest" });
    expect(r).toMatchObject({ ok: false, code: "STRIPE_FAILED" });
    // Our attempt was in flight, so the webhook refused to skip it.
    expect(firstDelivery).toBe(500);
    // The rollback used the stale read (S = 0): books at 0 for now...
    expect(await books(registrationId)).toMatchObject({ reg: 0, pay: [0] });
    // ...and Stripe's redelivery books the 40.
    expect(await deliverChargeRefunded(intents[0])).toBe(200);
    expect(await books(registrationId)).toMatchObject({ reg: 40, pay: [40] });
    await expectStripeCountersMatch(registrationId);
  });

  it("MED-3: the sweep settles a slice we have not sent yet; the refund stops and sends nothing more; books equal Stripe", async () => {
    const { eventId, registrationId } = await seedPaid({
      payments: [{ amount: 50, stripe: true }, { amount: 100, stripe: true }, { amount: 30, stripe: false }],
      credited: 180,
    });
    // While the first slice is with Stripe, more than 10 minutes "pass" for the
    // untouched attempts, and the sweep runs.
    fake.beforeCreate = async () => {
      fake.beforeCreate = null;
      const sent = await db.refundAttempt.findFirstOrThrow({ where: { registrationId }, orderBy: { updatedAt: "desc" }, select: { id: true } });
      await db.refundAttempt.updateMany({ where: { registrationId, id: { not: sent.id } }, data: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
      await resolveStaleRefundAttempts();
    };
    const r = await refundRegistration({ registrationId, eventId, source: "rest" }); // full 180
    expect(r).toMatchObject({ ok: false, code: "REFUND_STATE_UNKNOWN" });
    // One slice reached Stripe; the other Stripe slice was never sent.
    expect([...fake.refunds.values()].flat()).toHaveLength(1);
    await expectStripeCountersMatch(registrationId);

    // The sweep finishes the remainder (the manual one, left UNKNOWN).
    await ageAttempts(registrationId);
    await resolveStaleRefundAttempts();
    const b = await books(registrationId);
    expect(b.pay[2]).toBe(0); // the manual payment's refund was never recorded
    expect(b.reg).toBe(b.pay.reduce((sum, x) => sum + x, 0));
    await expectStripeCountersMatch(registrationId);
    const left = await db.refundAttempt.count({ where: { registrationId, status: { in: ["PENDING", "UNKNOWN"] } } });
    expect(left).toBe(0);
  });

  it("MED-1: running the sweep again over a rolled-back attempt changes nothing (no second rollback, no credit note)", async () => {
    const { eventId, registrationId } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    fake.createError = { err: new Error("ETIMEDOUT"), recordAnyway: false };
    fake.listError = new Error("unreachable");
    await refundRegistration({ registrationId, eventId, amount: 40, source: "rest" });
    fake.createError = null;
    fake.listError = null;
    await ageAttempts(registrationId);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ rolledBack: 1 });
    const after = await books(registrationId);

    // Force the attempt to look stale and unsettled to a second tick: it must
    // still refuse, because the rollback marked it in its own transaction.
    await ageAttempts(registrationId);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ scanned: 0 });
    await new Promise((res) => setTimeout(res, 300));
    expect(await books(registrationId)).toEqual(after);
  });
});

describe("review 2 MED-1 on Postgres: one attempt is taken back once", () => {
  it("the inline path and the sweep both try to roll back the same attempt: the second is refused and moves no money", async () => {
    const { eventId, registrationId, paymentIds } = await seedPaid({ payments: [{ amount: 100, stripe: false }], credited: 100 });
    // A booked manual refund of 40, never recorded: exactly what both would roll back.
    fake.createError = null;
    expect((await refundRegistration({ registrationId, eventId, amount: 40, source: "rest" })).ok).toBe(true);
    const attempt = await db.refundAttempt.findFirstOrThrow({ where: { registrationId }, select: { id: true } });
    await db.refundAttempt.update({ where: { id: attempt.id }, data: { status: "UNKNOWN" } });
    const rollback = () =>
      tenantTransaction((tx) =>
        unbookRefund(tx, {
          registrationId,
          slices: [{ attemptId: attempt.id, paymentId: paymentIds[0], take: 40, paymentBooked: true, stripe: null, failureNote: "test" }],
          flippedToRefunded: false,
        }),
      );
    await rollback();
    expect(await books(registrationId)).toMatchObject({ reg: 0, pay: [0] });
    await expect(rollback()).rejects.toBeInstanceOf(UnbookAttemptMoved);
    // Without the guard this would take 40 off again (and refuse only at zero).
    expect(await books(registrationId)).toMatchObject({ reg: 0, pay: [0] });
    const row = await db.refundAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true, error: true } });
    expect(row).toEqual({ status: "FAILED", error: "test" });
  });

  it("a refused rollback leaves the attempt's status untouched too (the mark and the money roll back together)", async () => {
    const { eventId, registrationId, paymentIds } = await seedPaid({ payments: [{ amount: 100, stripe: false }], credited: 100 });
    expect((await refundRegistration({ registrationId, eventId, amount: 40, source: "rest" })).ok).toBe(true);
    const attempt = await db.refundAttempt.findFirstOrThrow({ where: { registrationId }, select: { id: true } });
    await db.refundAttempt.update({ where: { id: attempt.id }, data: { status: "UNKNOWN" } });
    // The registration total is too small for the take: refused after the mark ran.
    await db.registration.update({ where: { id: registrationId }, data: { refundedAmount: 10 } });
    await expect(
      tenantTransaction((tx) =>
        unbookRefund(tx, {
          registrationId,
          slices: [{ attemptId: attempt.id, paymentId: paymentIds[0], take: 40, paymentBooked: true, stripe: null, failureNote: "test" }],
          flippedToRefunded: false,
        }),
      ),
    ).rejects.toThrow();
    const row = await db.refundAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true } });
    expect(row.status).toBe("UNKNOWN");
  });
});

describe("the sweep on its own", () => {
  async function staleAttempt(registrationId: string, paymentId: string, intent: string, amount: number, paymentBooked: boolean) {
    return db.refundAttempt.create({
      data: {
        organizationId: seed.orgId, registrationId, paymentId, stripePaymentIntentId: intent,
        amount, refundedBefore: 0, refundedAfter: amount, kind: "stripe", status: "PENDING", source: "rest",
        paymentBooked, createdAt: new Date(Date.now() - 60 * 60 * 1000), updatedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
      select: { id: true },
    });
  }

  it("LOW-1: an attempt the previous image wrote (registration booked, payment counter not) is taken back without touching the payment", async () => {
    const { registrationId, paymentIds, intents } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    await db.registration.update({ where: { id: registrationId }, data: { refundedAmount: 40 } });
    await staleAttempt(registrationId, paymentIds[0], intents[0], 40, false);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ rolledBack: 1 });
    expect(await books(registrationId)).toMatchObject({ reg: 0, pay: [0] });
  });

  it("a counter Stripe and our attempts cannot explain is refused and left exactly as it was", async () => {
    const { registrationId, paymentIds, intents } = await seedPaid({ payments: [{ amount: 100, stripe: true }], credited: 100 });
    await db.registration.update({ where: { id: registrationId }, data: { refundedAmount: 90 } });
    await db.payment.update({ where: { id: paymentIds[0] }, data: { refundedAmount: 90 } });
    const attempt = await staleAttempt(registrationId, paymentIds[0], intents[0], 40, true);
    expect(await resolveStaleRefundAttempts()).toMatchObject({ needsReview: 1, rolledBack: 0 });
    expect(await books(registrationId)).toMatchObject({ reg: 90, pay: [90] });
    const row = await db.refundAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true } });
    expect(row.status).toBe("FAILED");
  });
});

describe("manual refunds", () => {
  it("each manual payment gets its own attempt, both counters move, no Stripe", async () => {
    const { eventId, registrationId } = await seedPaid({ payments: [{ amount: 40, stripe: false }, { amount: 60, stripe: false }], credited: 100 });
    const r = await refundRegistration({ registrationId, eventId, source: "rest" });
    expect(r.ok).toBe(true);
    expect(await books(registrationId)).toMatchObject({ reg: 100, pay: [40, 60], regStatus: "REFUNDED", payStatus: ["REFUNDED", "REFUNDED"] });
    const attempts = await db.refundAttempt.findMany({ where: { registrationId }, select: { status: true, paymentBooked: true } });
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === "SUCCEEDED" && a.paymentBooked)).toBe(true);
  });
});
