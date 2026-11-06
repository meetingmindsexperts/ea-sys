/**
 * The refund rollback's arithmetic (security audit W0-1 follow-up, Nov 6 2026).
 *
 * An in-memory fake of the four tables it touches, so every scenario is worked
 * out by hand in the test name. The same function is exercised against real
 * Postgres in tests/integration-db/refund-counters.db.test.ts; this file is
 * where the cases are enumerated.
 *
 * Notation: C = the payment's counter now, S = what Stripe says is refunded on
 * the charge, R = the registration's refunded total.
 */
import { describe, it, expect } from "vitest";
import { unbookRefund, UnbookAttemptMoved, UnbookNeedsReview, UnbookRaced, type UnbookSlice } from "@/services/refund-unbook";

type Status = "PAID" | "REFUNDED";
interface Store {
  reg: { id: string; refundedAmount: number; paymentStatus: string };
  payments: Array<{ id: string; registrationId: string; amount: number; refundedAmount: number; status: Status }>;
  attempts: Array<{ id: string; paymentId: string | null; amount: number; status: string; paymentBooked: boolean; updatedAt?: Date; error?: string }>;
  /** Simulates a concurrent writer between the read and the write. */
  raceOn?: "payment" | "registration";
  writes: number;
}

function fakeTx(store: Store) {
  return {
    registration: {
      findUnique: async () => ({ refundedAmount: store.reg.refundedAmount, paymentStatus: store.reg.paymentStatus }),
      updateMany: async ({ where, data }: { where: { refundedAmount: number }; data: { refundedAmount: number; paymentStatus?: string } }) => {
        if (store.raceOn === "registration") store.reg.refundedAmount += 1;
        if (store.reg.refundedAmount !== where.refundedAmount) return { count: 0 };
        store.reg.refundedAmount = data.refundedAmount;
        if (data.paymentStatus) store.reg.paymentStatus = data.paymentStatus;
        store.writes++;
        return { count: 1 };
      },
    },
    payment: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const p = store.payments.find((x) => x.id === where.id);
        return p ? { refundedAmount: p.refundedAmount, amount: p.amount } : null;
      },
      updateMany: async ({ where, data }: { where: { id: string; refundedAmount: number }; data: { refundedAmount: number; status: Status } }) => {
        const p = store.payments.find((x) => x.id === where.id)!;
        if (store.raceOn === "payment") p.refundedAmount += 1;
        if (p.refundedAmount !== where.refundedAmount) return { count: 0 };
        p.refundedAmount = data.refundedAmount;
        p.status = data.status;
        store.writes++;
        return { count: 1 };
      },
      aggregate: async () => ({
        _sum: { amount: store.payments.length ? store.payments.reduce((s, p) => s + p.amount, 0) : null },
      }),
    },
    refundAttempt: {
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] }; updatedAt?: Date }; data: { status: string; error: string } }) => {
        const a = store.attempts.find((x) => x.id === where.id);
        if (!a || !where.status.in.includes(a.status)) return { count: 0 };
        if (where.updatedAt && a.updatedAt?.getTime() !== where.updatedAt.getTime()) return { count: 0 };
        a.status = data.status;
        a.error = data.error;
        store.writes++;
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { paymentId: string; id: { notIn: string[] } } }) =>
        store.attempts.filter(
          (a) =>
            a.paymentId === where.paymentId &&
            ["PENDING", "UNKNOWN"].includes(a.status) &&
            a.paymentBooked &&
            !where.id.notIn.includes(a.id),
        ),
    },
  } as never;
}

/** The attempt being rolled back, att1, is always present and PENDING unless a test says otherwise. */
const OWN = (extra: Partial<Store["attempts"][number]> = {}) => ({
  id: "att1", paymentId: "p1", amount: 60, status: "PENDING", paymentBooked: true, updatedAt: new Date("2026-11-06T10:00:00Z"), ...extra,
});

function setup(opts: { C: number; R: number; amount?: number; regStatus?: string; attempts?: Store["attempts"] }): Store {
  return {
    reg: { id: "reg1", refundedAmount: opts.R, paymentStatus: opts.regStatus ?? "PAID" },
    payments: [{ id: "p1", registrationId: "reg1", amount: opts.amount ?? 100, refundedAmount: opts.C, status: "PAID" }],
    attempts: [OWN(), ...(opts.attempts ?? [])],
    writes: 0,
  };
}

const slice = (take: number, S: number | null, extra: Partial<UnbookSlice> = {}): UnbookSlice => ({
  attemptId: "att1",
  paymentId: "p1",
  take,
  paymentBooked: true,
  stripe: S == null ? null : { refundedTotal: S, attemptIds: [] },
  failureNote: "test rollback",
  ...extra,
});

const run = (store: Store, slices: UnbookSlice[], flippedToRefunded = false) =>
  unbookRefund(fakeTx(store), { registrationId: "reg1", slices, flippedToRefunded });

describe("unbookRefund: Stripe payment", () => {
  it("plain failure. Our 60 booked (C 60, R 60), Stripe holds nothing (S 0): both back to 0", async () => {
    const store = setup({ C: 60, R: 60 });
    const r = await run(store, [slice(60, 0)]);
    expect(r).toEqual({ unbooked: 60, absorbed: [], registrationRefunded: 0 });
    expect(store.payments[0]).toMatchObject({ refundedAmount: 0, status: "PAID" });
    expect(store.reg).toMatchObject({ refundedAmount: 0, paymentStatus: "PAID" });
  });

  it("MED-1. A Dashboard 50 landed while our 60 was booked and its webhook skipped it (C 60, R 60, S 50): books keep 50", async () => {
    const store = setup({ C: 60, R: 60 });
    const r = await run(store, [slice(60, 50)]);
    expect(r.absorbed).toEqual([{ paymentId: "p1", amount: 50 }]);
    expect(store.payments[0].refundedAmount).toBe(50);
    expect(store.reg.refundedAmount).toBe(50);
  });

  it("MED-1 variant. A Dashboard 70; its webhook booked the 10 it could see and set C to 70 (R 70, S 70): books keep 70, 60 newly found", async () => {
    const store = setup({ C: 70, R: 70 });
    const r = await run(store, [slice(60, 70)]);
    // The webhook recorded 10 with its own credit note; the other 60 is found here.
    expect(r.absorbed).toEqual([{ paymentId: "p1", amount: 60 }]);
    expect(store.payments[0].refundedAmount).toBe(70);
    expect(store.reg.refundedAmount).toBe(70);
  });

  it("a Dashboard 70 whose webhook has not arrived yet (C 60, R 60, S 70): books go UP to 70, so the late webhook reads delta 0", async () => {
    const store = setup({ C: 60, R: 60 });
    const r = await run(store, [slice(60, 70)]);
    expect(r).toMatchObject({ unbooked: -10, absorbed: [{ paymentId: "p1", amount: 70 }] });
    expect(store.payments[0].refundedAmount).toBe(70);
    expect(store.reg.refundedAmount).toBe(70);
  });

  it("another refund of ours is booked on the same payment and not yet at Stripe (C 80 = 60 + 20, S 0): its 20 is kept", async () => {
    const store = setup({ C: 80, R: 80, attempts: [{ id: "att2", paymentId: "p1", amount: 20, status: "PENDING", paymentBooked: true }] });
    await run(store, [slice(60, 0)]);
    expect(store.payments[0].refundedAmount).toBe(20);
    expect(store.reg.refundedAmount).toBe(20);
  });

  it("...and when that other refund has already reached Stripe (S 20, Stripe knows att2): counted once, not twice", async () => {
    const store = setup({ C: 80, R: 80, attempts: [{ id: "att2", paymentId: "p1", amount: 20, status: "PENDING", paymentBooked: true }] });
    await run(store, [{ ...slice(60, 20), stripe: { refundedTotal: 20, attemptIds: ["att2"] } }]);
    expect(store.payments[0].refundedAmount).toBe(20);
    expect(store.reg.refundedAmount).toBe(20);
  });

  it("an in-flight attempt written by the previous image did not raise C, so it is not added back", async () => {
    const store = setup({ C: 60, R: 80, attempts: [{ id: "att2", paymentId: "p1", amount: 20, status: "PENDING", paymentBooked: false }] });
    await run(store, [slice(60, 0)]);
    expect(store.payments[0].refundedAmount).toBe(0);
    expect(store.reg.refundedAmount).toBe(20);
  });

  it("LOW-1. An attempt from the previous image booked only the registration (C 0, R 60, paymentBooked false): C stays 0, R goes to 0", async () => {
    const store = setup({ C: 0, R: 60 });
    const r = await run(store, [slice(60, 0, { paymentBooked: false })]);
    expect(r).toMatchObject({ unbooked: 60, absorbed: [] });
    expect(store.payments[0].refundedAmount).toBe(0);
    expect(store.reg.refundedAmount).toBe(0);
  });

  it("a full refund found on the way keeps the registration REFUNDED (C 100, R 100 flipped, S 100)", async () => {
    const store = setup({ C: 100, R: 100, regStatus: "REFUNDED" });
    const r = await run(store, [slice(100, 100)], true);
    expect(r.absorbed).toEqual([{ paymentId: "p1", amount: 100 }]);
    expect(store.payments[0]).toMatchObject({ refundedAmount: 100, status: "REFUNDED" });
    expect(store.reg).toMatchObject({ refundedAmount: 100, paymentStatus: "REFUNDED" });
  });

  it("a full refund that failed un-flips the registration (C 100, R 100 flipped, S 0)", async () => {
    const store = setup({ C: 100, R: 100, regStatus: "REFUNDED" });
    store.payments[0].status = "REFUNDED";
    await run(store, [slice(100, 0)], true);
    expect(store.payments[0]).toMatchObject({ refundedAmount: 0, status: "PAID" });
    expect(store.reg).toMatchObject({ refundedAmount: 0, paymentStatus: "PAID" });
  });

  it("Stripe's figure is capped at the payment's amount", async () => {
    const store = setup({ C: 60, R: 60 });
    await run(store, [slice(60, 250)]);
    expect(store.payments[0].refundedAmount).toBe(100);
  });

  it("the counter holds more than Stripe and our in-flight attempts explain (C 90, our 60, S 0): refused, nothing written", async () => {
    const store = setup({ C: 90, R: 90 });
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookNeedsReview);
    // No money moved. (The attempt's status mark ran first in the fake; in the
    // real transaction the throw rolls it back with everything else, which
    // tests/integration-db/refund-counters.db.test.ts checks on Postgres.)
    expect(store.payments[0].refundedAmount).toBe(90);
    expect(store.reg.refundedAmount).toBe(90);
  });
});

describe("unbookRefund: manual payments and residue", () => {
  it("a manual payment's booking comes straight back (no Stripe figure)", async () => {
    const store = setup({ C: 30, R: 30, amount: 30 });
    store.payments[0].status = "REFUNDED";
    const r = await run(store, [slice(30, null)]);
    expect(r).toEqual({ unbooked: 30, absorbed: [], registrationRefunded: 0 });
    expect(store.payments[0]).toMatchObject({ refundedAmount: 0, status: "PAID" });
  });

  it("residue with no payment rows: only the registration, and the booking's own flag un-flips it", async () => {
    const store = setup({ C: 0, R: 100, regStatus: "REFUNDED" });
    store.payments = [];
    await run(store, [slice(100, null, { paymentId: null })], true);
    expect(store.reg).toMatchObject({ refundedAmount: 0, paymentStatus: "PAID" });
  });

  it("a registration in neither PAID nor REFUNDED keeps its status", async () => {
    const store = setup({ C: 60, R: 60, regStatus: "COMPLIMENTARY" });
    await run(store, [slice(60, 0)]);
    expect(store.reg.paymentStatus).toBe("COMPLIMENTARY");
  });
});

describe("unbookRefund: once per attempt (review 2, MED-1)", () => {
  it("marks the attempt FAILED with its note, in the same transaction as the money", async () => {
    const store = setup({ C: 60, R: 60 });
    await run(store, [slice(60, 0)]);
    expect(store.attempts[0]).toMatchObject({ status: "FAILED", error: "test rollback" });
  });

  it("a second rollback of the same attempt is refused and writes nothing (it used to take the money back twice)", async () => {
    const store = setup({ C: 60, R: 60 });
    await run(store, [slice(60, 0)]);
    const writes = store.writes;
    const snapshot = JSON.stringify({ reg: store.reg, payments: store.payments });
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookAttemptMoved);
    expect(store.writes).toBe(writes);
    expect(JSON.stringify({ reg: store.reg, payments: store.payments })).toBe(snapshot);
  });

  it("an attempt already SUCCEEDED (the refund went through) is never rolled back", async () => {
    const store = setup({ C: 60, R: 60 });
    store.attempts[0].status = "SUCCEEDED";
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookAttemptMoved);
    expect(store.writes).toBe(0);
  });

  it("the sweep's read is stale (the refund service touched the attempt since): refused, nothing written", async () => {
    const store = setup({ C: 60, R: 60 });
    store.attempts[0].updatedAt = new Date("2026-11-06T10:15:00Z");
    await expect(run(store, [slice(60, 0, { expectedUpdatedAt: new Date("2026-11-06T10:00:00Z") })])).rejects.toBeInstanceOf(UnbookAttemptMoved);
    expect(store.writes).toBe(0);
    expect(store.reg.refundedAmount).toBe(60);
  });
});

describe("unbookRefund: missing rows (final review M1)", () => {
  it("a payment that no longer exists is a case for a human, not a race to retry forever", async () => {
    const store = setup({ C: 60, R: 60 });
    await expect(run(store, [slice(60, 0, { paymentId: "gone" })])).rejects.toBeInstanceOf(UnbookNeedsReview);
  });
});

describe("unbookRefund: all or nothing", () => {
  it("a concurrent payment write is detected (UnbookRaced)", async () => {
    const store = setup({ C: 60, R: 60 });
    store.raceOn = "payment";
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookRaced);
  });

  it("a concurrent registration write is detected (UnbookRaced) after the payment write; the caller's transaction undoes it", async () => {
    const store = setup({ C: 60, R: 60 });
    store.raceOn = "registration";
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookRaced);
  });

  it("a registration total that would go negative is refused", async () => {
    const store = setup({ C: 60, R: 10 });
    await expect(run(store, [slice(60, 0)])).rejects.toBeInstanceOf(UnbookNeedsReview);
  });
});
