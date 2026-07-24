/**
 * applyRegistrationTransition — the single shared seat+promo transition applier
 * (replaces the "MUST mirror the REST route" copies). planSeatTransition/
 * releaseSeat/claimSeat are the REAL pure/guarded primitives; only `tx` is mocked.
 *
 * Promo `usedCount` moves symmetrically (review H6): cancel releases with a
 * `usedCount >= n` guard (via releasePromoUsage); reactivation re-claims.
 * Before the fix, cancel → reactivate → cancel double-decremented and could
 * drive the counter negative.
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyRegistrationTransition,
  claimEventSeats,
  claimPromoUsage,
  claimSeats,
  claimSeatsOverselling,
  incrementEventSeatsOverselling,
  releaseEventSeats,
  releasePromoUsage,
  type RegistrationTransitionInput,
} from "@/lib/registration-seat-db";

type Counter = { count: number };
function makeTx(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const tx = {
    calls,
    ticketType: {
      findUnique: vi.fn().mockResolvedValue({ quantity: 100 }),
      updateMany: vi.fn().mockImplementation((a: { data: unknown }) => {
        calls.push(JSON.stringify(a.data).includes("increment") ? "tt-claim" : "tt-release");
        return Promise.resolve({ count: 1 } as Counter);
      }),
    },
    pricingTier: {
      findUnique: vi.fn().mockResolvedValue({ quantity: 100 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    promoCode: {
      updateMany: vi.fn().mockImplementation((a: { data: unknown }) => {
        calls.push(JSON.stringify(a.data).includes("increment") ? "promo-claim" : "promo-release");
        return Promise.resolve({ count: 1 } as Counter);
      }),
    },
    // Event-wide seat counter: the guarded claim is raw SQL ($executeRaw);
    // release + the unguarded overselling increment go through event.updateMany.
    event: {
      findUnique: vi.fn().mockResolvedValue({ seatCount: 0, maxAttendees: null }),
      updateMany: vi.fn().mockImplementation((a: { data: unknown }) => {
        calls.push(JSON.stringify(a.data).includes("increment") ? "evt-increment" : "evt-release");
        return Promise.resolve({ count: 1 } as Counter);
      }),
    },
    $executeRaw: vi.fn().mockImplementation(() => {
      calls.push("evt-claim");
      return Promise.resolve(1);
    }),
    ...over,
  };
  return tx as unknown as Parameters<typeof applyRegistrationTransition>[0] & {
    calls: string[];
    ticketType: { updateMany: ReturnType<typeof vi.fn> };
    promoCode: { updateMany: ReturnType<typeof vi.fn> };
  };
}

/**
 * Faithful single-row simulation of Prisma `promoCode.updateMany` for the three
 * write shapes releasePromoUsage / claimPromoUsage emit: guarded decrement
 * (`usedCount: { gte: n }`), clamp-to-zero (`usedCount: 0` with a `gt: 0`
 * guard), and unguarded increment.
 */
type PromoUpdateManyArgs = {
  where: { usedCount?: { gte?: number; gt?: number } };
  data: { usedCount: number | { decrement?: number; increment?: number } };
};
function simulatedPromoCounter(get: () => number, set: (v: number) => void) {
  return (a: PromoUpdateManyArgs) => {
    const cur = get();
    if (a.where.usedCount?.gte !== undefined && cur < a.where.usedCount.gte) return Promise.resolve({ count: 0 });
    if (a.where.usedCount?.gt !== undefined && cur <= a.where.usedCount.gt) return Promise.resolve({ count: 0 });
    if (typeof a.data.usedCount === "number") set(a.data.usedCount);
    else if (a.data.usedCount.decrement) set(cur - a.data.usedCount.decrement);
    else if (a.data.usedCount.increment) set(cur + a.data.usedCount.increment);
    return Promise.resolve({ count: 1 });
  };
}

/** applyRegistrationTransition with the test default eventId. */
const apply = (
  tx: Parameters<typeof applyRegistrationTransition>[0],
  input: Omit<RegistrationTransitionInput, "eventId"> & { eventId?: string },
) => applyRegistrationTransition(tx, { eventId: "evt1", ...input });

const state = (over: Record<string, unknown>) => ({
  status: "CONFIRMED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null,
  ...over,
}) as never;

describe("applyRegistrationTransition", () => {
  it("cancel (→CANCELLED) releases the seat + promo (guarded), no claim", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED" }),
      next: state({ status: "CANCELLED" }),
      promoCodeId: "promo1",
    });
    expect(tx.calls).toEqual(["tt-release", "evt-release", "promo-release"]);
    // The gte guard is the never-below-zero contract (review H6).
    expect(tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1", usedCount: { gte: 1 } },
      data: { usedCount: { decrement: 1 } },
    });
  });

  it("cancel without a promo → releases seat only", async () => {
    const tx = makeTx();
    await apply(tx, { prev: state({ status: "CONFIRMED" }), next: state({ status: "CANCELLED" }), promoCodeId: null });
    expect(tx.calls).toEqual(["tt-release", "evt-release"]);
  });

  it("reactivate (CANCELLED→CONFIRMED) claims the seat AND re-claims the promo (review H6)", async () => {
    const tx = makeTx();
    await apply(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" });
    expect(tx.calls).toEqual(["tt-claim", "evt-claim", "promo-claim"]);
    expect(tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1" },
      data: { usedCount: { increment: 1 } },
    });
  });

  it("cancel → reactivate → cancel nets to ZERO promo movement (the double-release bug)", async () => {
    // Simulate the counter so the sequence is verifiable end-to-end.
    let usedCount = 1;
    const tx = makeTx({
      promoCode: { updateMany: vi.fn().mockImplementation(simulatedPromoCounter(() => usedCount, (v) => { usedCount = v; })) },
    });
    const cancel = { prev: state({ status: "CONFIRMED" }), next: state({ status: "CANCELLED" }), promoCodeId: "promo1" };
    const react = { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" };
    await apply(tx, cancel); // 1 → 0
    await apply(tx, react);  // 0 → 1
    await apply(tx, cancel); // 1 → 0 (NOT −1)
    expect(usedCount).toBe(0);
  });

  it("type change releases the old counter + claims the new", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED", ticketTypeId: "ttOld" }),
      next: state({ status: "CONFIRMED", ticketTypeId: "ttNew" }),
    });
    // eventDelta is 0 on a type change — the person is still ONE attendee,
    // so the event-wide counter must not move.
    expect(tx.calls).toEqual(["tt-release", "tt-claim"]);
  });

  it("throws CAPACITY_EXCEEDED when the claim can't be satisfied", async () => {
    const tx = makeTx({
      ticketType: {
        findUnique: vi.fn().mockResolvedValue({ quantity: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }), // at capacity
      },
    });
    await expect(
      apply(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }) }),
    ).rejects.toThrow("CAPACITY_EXCEEDED");
  });

  it("no-op transition (same counter, same status) touches nothing", async () => {
    const tx = makeTx();
    await apply(tx, { prev: state({ status: "CONFIRMED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" });
    expect(tx.calls).toEqual([]);
  });

  it("status-only change between active states never touches the promo", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED" }),
      next: state({ status: "CHECKED_IN" }),
      promoCodeId: "promo1",
    });
    expect(tx.promoCode.updateMany).not.toHaveBeenCalled();
  });

  it("virtual reg holds no seat → cancel releases nothing, still releases promo", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED", attendanceMode: "VIRTUAL" }),
      next: state({ status: "CANCELLED", attendanceMode: "VIRTUAL" }),
      promoCodeId: "promo1",
    });
    expect(tx.calls).toEqual(["promo-release"]);
  });

  it("throws EVENT_FULL when the event-wide claim can't be satisfied (single-path hard block)", async () => {
    const tx = makeTx({
      $executeRaw: vi.fn().mockResolvedValue(0), // event at maxAttendees
    });
    await expect(
      apply(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }) }),
    ).rejects.toThrow("EVENT_FULL");
  });

  it("mode switch VIRTUAL→IN_PERSON claims a ticket seat AND an event seat", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED", attendanceMode: "VIRTUAL" }),
      next: state({ status: "CONFIRMED", attendanceMode: "IN_PERSON" }),
    });
    expect(tx.calls).toEqual(["tt-claim", "evt-claim"]);
  });

  it("speaker companion (no counter) never moves the event counter", async () => {
    const tx = makeTx();
    await apply(tx, {
      prev: state({ status: "CONFIRMED", createdSource: "SPEAKER_COMPANION" }),
      next: state({ status: "CANCELLED", createdSource: "SPEAKER_COMPANION" }),
    });
    expect(tx.calls).toEqual([]);
  });
});

describe("event-wide seat helpers (Event.maxAttendees / Event.seatCount)", () => {
  it("claimEventSeats: raw conditional UPDATE, affected rows > 0 → true", async () => {
    const $executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw } as unknown as Parameters<typeof claimEventSeats>[0];
    expect(await claimEventSeats(tx, "evt1")).toBe(true);
    expect($executeRaw).toHaveBeenCalledTimes(1);
  });

  it("claimEventSeats: 0 affected rows (event full) → false", async () => {
    const $executeRaw = vi.fn().mockResolvedValue(0);
    const tx = { $executeRaw } as unknown as Parameters<typeof claimEventSeats>[0];
    expect(await claimEventSeats(tx, "evt1")).toBe(false);
  });

  it("claimEventSeats: count <= 0 → true without a query", async () => {
    const $executeRaw = vi.fn();
    const tx = { $executeRaw } as unknown as Parameters<typeof claimEventSeats>[0];
    expect(await claimEventSeats(tx, "evt1", 0)).toBe(true);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("releaseEventSeats: guarded decrement (seatCount >= n), never below 0", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { event: { updateMany } } as unknown as Parameters<typeof releaseEventSeats>[0];
    await releaseEventSeats(tx, "evt1", 2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "evt1", seatCount: { gte: 2 } },
      data: { seatCount: { decrement: 2 } },
    });
  });

  it("incrementEventSeatsOverselling: unguarded increment, reports over-cap", async () => {
    const findUnique = vi.fn().mockResolvedValue({ seatCount: 99, maxAttendees: 100 });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { event: { findUnique, updateMany } } as unknown as Parameters<typeof incrementEventSeatsOverselling>[0];
    const res = await incrementEventSeatsOverselling(tx, "evt1", 3);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "evt1" },
      data: { seatCount: { increment: 3 } },
    });
    expect(res).toEqual({ oversold: true, newSeatCount: 102, maxAttendees: 100 });
  });

  it("incrementEventSeatsOverselling: null maxAttendees (unlimited) never reports oversold", async () => {
    const findUnique = vi.fn().mockResolvedValue({ seatCount: 5000, maxAttendees: null });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { event: { findUnique, updateMany } } as unknown as Parameters<typeof incrementEventSeatsOverselling>[0];
    const res = await incrementEventSeatsOverselling(tx, "evt1");
    expect(res.oversold).toBe(false);
  });
});

describe("releasePromoUsage / claimPromoUsage (guarded bulk promo accounting)", () => {
  function promoTx(initial: number) {
    let usedCount = initial;
    const updateMany = vi.fn().mockImplementation(simulatedPromoCounter(() => usedCount, (v) => { usedCount = v; }));
    const findUnique = vi.fn().mockImplementation(() => Promise.resolve({ usedCount }));
    const tx = { promoCode: { updateMany, findUnique } } as unknown as Parameters<typeof releasePromoUsage>[0];
    return { tx, updateMany, value: () => usedCount };
  }

  it("releases n uses when the counter holds them", async () => {
    const p = promoTx(5);
    await releasePromoUsage(p.tx, "promo1", 3);
    expect(p.value()).toBe(2);
    expect(p.updateMany).toHaveBeenCalledTimes(1);
  });

  it("NEVER goes negative: counter below the release clamps to 0 (was the unguarded-decrement bug)", async () => {
    const p = promoTx(2);
    await releasePromoUsage(p.tx, "promo1", 5);
    expect(p.value()).toBe(0); // clamped, not −3 and not stuck at 2
    // Review M1: the fallback must be a RELATIVE guarded decrement, never an
    // absolute `set 0` — an absolute set could erase a redemption a concurrent
    // registration committed between the two statements.
    const fallback = p.updateMany.mock.calls[1][0] as { data: { usedCount: unknown } };
    expect(fallback.data.usedCount).toEqual({ decrement: 2 });
  });

  it("counter already at 0 stays 0", async () => {
    const p = promoTx(0);
    await releasePromoUsage(p.tx, "promo1", 1);
    expect(p.value()).toBe(0);
  });

  it("count <= 0 is a no-op (no query)", async () => {
    const p = promoTx(4);
    await releasePromoUsage(p.tx, "promo1", 0);
    expect(p.updateMany).not.toHaveBeenCalled();
  });

  it("claimPromoUsage re-claims n uses via updateMany (hard-deleted row no-ops, never throws)", async () => {
    const p = promoTx(1);
    await claimPromoUsage(p.tx as unknown as Parameters<typeof claimPromoUsage>[0], "promo1", 2);
    expect(p.value()).toBe(3);
    expect(p.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1" },
      data: { usedCount: { increment: 2 } },
    });
  });
});

describe("claimSeats / claimSeatsOverselling (bulk seat claims)", () => {
  function seatTx(quantity: number, soldCount: number, kind: "tier" | "ticketType" = "ticketType") {
    const row = { quantity, soldCount, name: "Standard" };
    const model = {
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockImplementation((a: { where: { soldCount?: { lte: number } } }) => {
        if (a.where.soldCount !== undefined && row.soldCount > a.where.soldCount.lte) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: 1 });
      }),
    };
    const tx = {
      ticketType: kind === "ticketType" ? model : { findUnique: vi.fn(), updateMany: vi.fn() },
      pricingTier: kind === "tier" ? model : { findUnique: vi.fn(), updateMany: vi.fn() },
    } as unknown as Parameters<typeof claimSeats>[0];
    return { tx, model };
  }

  it("claimSeats is all-or-nothing: fits → true, doesn't fit → false (no partial claim)", async () => {
    const fits = seatTx(10, 7);
    expect(await claimSeats(fits.tx, { kind: "ticketType", id: "tt1" }, 3)).toBe(true);
    const doesNotFit = seatTx(10, 8);
    expect(await claimSeats(doesNotFit.tx, { kind: "ticketType", id: "tt1" }, 3)).toBe(false);
  });

  it("claimSeats: missing counter row → false; count <= 0 → true without a query", async () => {
    const missing = seatTx(10, 0);
    missing.model.findUnique.mockResolvedValue(null);
    expect(await claimSeats(missing.tx, { kind: "tier", id: "gone" }, 1)).toBe(false);
    const p = seatTx(10, 0);
    expect(await claimSeats(p.tx, { kind: "ticketType", id: "tt1" }, 0)).toBe(true);
    expect(p.model.updateMany).not.toHaveBeenCalled();
  });

  it("claimSeatsOverselling increments UNGUARDED and reports the oversell for the caller to log", async () => {
    const p = seatTx(10, 9, "tier");
    const res = await claimSeatsOverselling(p.tx, { kind: "tier", id: "tier1" }, 3);
    expect(p.model.updateMany).toHaveBeenCalledWith({
      where: { id: "tier1" },
      data: { soldCount: { increment: 3 } },
    });
    expect(res).toEqual({ oversold: true, counterName: "Standard", newSoldCount: 12, quantity: 10 });
  });

  it("claimSeatsOverselling within capacity → oversold false", async () => {
    const p = seatTx(10, 2);
    const res = await claimSeatsOverselling(p.tx, { kind: "ticketType", id: "tt1" }, 3);
    expect(res.oversold).toBe(false);
    expect(res.newSoldCount).toBe(5);
  });
});
