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
  claimPromoUsage,
  claimSeats,
  claimSeatsOverselling,
  releasePromoUsage,
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

const state = (over: Record<string, unknown>) => ({
  status: "CONFIRMED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null,
  ...over,
}) as never;

describe("applyRegistrationTransition", () => {
  it("cancel (→CANCELLED) releases the seat + promo (guarded), no claim", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, {
      prev: state({ status: "CONFIRMED" }),
      next: state({ status: "CANCELLED" }),
      promoCodeId: "promo1",
    });
    expect(tx.calls).toEqual(["tt-release", "promo-release"]);
    // The gte guard is the never-below-zero contract (review H6).
    expect(tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1", usedCount: { gte: 1 } },
      data: { usedCount: { decrement: 1 } },
    });
  });

  it("cancel without a promo → releases seat only", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, { prev: state({ status: "CONFIRMED" }), next: state({ status: "CANCELLED" }), promoCodeId: null });
    expect(tx.calls).toEqual(["tt-release"]);
  });

  it("reactivate (CANCELLED→CONFIRMED) claims the seat AND re-claims the promo (review H6)", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" });
    expect(tx.calls).toEqual(["tt-claim", "promo-claim"]);
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
    await applyRegistrationTransition(tx, cancel); // 1 → 0
    await applyRegistrationTransition(tx, react);  // 0 → 1
    await applyRegistrationTransition(tx, cancel); // 1 → 0 (NOT −1)
    expect(usedCount).toBe(0);
  });

  it("type change releases the old counter + claims the new", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, {
      prev: state({ status: "CONFIRMED", ticketTypeId: "ttOld" }),
      next: state({ status: "CONFIRMED", ticketTypeId: "ttNew" }),
    });
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
      applyRegistrationTransition(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }) }),
    ).rejects.toThrow("CAPACITY_EXCEEDED");
  });

  it("no-op transition (same counter, same status) touches nothing", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, { prev: state({ status: "CONFIRMED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" });
    expect(tx.calls).toEqual([]);
  });

  it("status-only change between active states never touches the promo", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, {
      prev: state({ status: "CONFIRMED" }),
      next: state({ status: "CHECKED_IN" }),
      promoCodeId: "promo1",
    });
    expect(tx.promoCode.updateMany).not.toHaveBeenCalled();
  });

  it("virtual reg holds no seat → cancel releases nothing, still releases promo", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, {
      prev: state({ status: "CONFIRMED", attendanceMode: "VIRTUAL" }),
      next: state({ status: "CANCELLED", attendanceMode: "VIRTUAL" }),
      promoCodeId: "promo1",
    });
    expect(tx.calls).toEqual(["promo-release"]);
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
