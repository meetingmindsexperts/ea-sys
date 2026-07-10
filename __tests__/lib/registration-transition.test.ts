/**
 * applyRegistrationTransition — the single shared seat+promo transition applier
 * (replaces the "MUST mirror the REST route" copies). planSeatTransition/
 * releaseSeat/claimSeat are the REAL pure/guarded primitives; only `tx` is mocked.
 *
 * Promo `usedCount` moves symmetrically (review H6): cancel releases with a
 * `usedCount > 0` guard; reactivation re-claims. Before the fix, cancel →
 * reactivate → cancel double-decremented and could drive the counter negative.
 */
import { describe, it, expect, vi } from "vitest";
import { applyRegistrationTransition } from "@/lib/registration-seat-db";

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
    // The gt: 0 guard is the never-below-zero contract (review H6).
    expect(tx.promoCode.updateMany).toHaveBeenCalledWith({
      where: { id: "promo1", usedCount: { gt: 0 } },
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
      promoCode: {
        updateMany: vi.fn().mockImplementation((a: { where: { usedCount?: { gt: number } }; data: { usedCount: { decrement?: number; increment?: number } } }) => {
          if (a.data.usedCount.decrement) {
            if (usedCount <= (a.where.usedCount?.gt ?? -1)) return Promise.resolve({ count: 0 });
            usedCount -= 1;
          } else {
            usedCount += 1;
          }
          return Promise.resolve({ count: 1 });
        }),
      },
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
