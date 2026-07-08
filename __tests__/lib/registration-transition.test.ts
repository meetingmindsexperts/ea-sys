/**
 * applyRegistrationTransition — the single shared seat+promo transition applier
 * (replaces the "MUST mirror the REST route" copies). planSeatTransition/
 * releaseSeat/claimSeat are the REAL pure/guarded primitives; only `tx` is mocked.
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
      update: vi.fn().mockImplementation(() => { calls.push("promo-release"); return Promise.resolve({}); }),
    },
    ...over,
  };
  return tx as unknown as Parameters<typeof applyRegistrationTransition>[0] & { calls: string[]; ticketType: { updateMany: ReturnType<typeof vi.fn> }; promoCode: { update: ReturnType<typeof vi.fn> } };
}

const state = (over: Record<string, unknown>) => ({
  status: "CONFIRMED", attendanceMode: "IN_PERSON", ticketTypeId: "tt1", pricingTierId: null, createdSource: null,
  ...over,
}) as never;

describe("applyRegistrationTransition", () => {
  it("cancel (→CANCELLED) releases the seat + promo, no claim", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, {
      prev: state({ status: "CONFIRMED" }),
      next: state({ status: "CANCELLED" }),
      promoCodeId: "promo1",
    });
    expect(tx.calls).toEqual(["tt-release", "promo-release"]);
    expect(tx.promoCode.update).toHaveBeenCalledWith({ where: { id: "promo1" }, data: { usedCount: { decrement: 1 } } });
  });

  it("cancel without a promo → releases seat only", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, { prev: state({ status: "CONFIRMED" }), next: state({ status: "CANCELLED" }), promoCodeId: null });
    expect(tx.calls).toEqual(["tt-release"]);
  });

  it("reactivate (CANCELLED→CONFIRMED) claims a seat, no promo release", async () => {
    const tx = makeTx();
    await applyRegistrationTransition(tx, { prev: state({ status: "CANCELLED" }), next: state({ status: "CONFIRMED" }), promoCodeId: "promo1" });
    expect(tx.calls).toEqual(["tt-claim"]);
    expect(tx.promoCode.update).not.toHaveBeenCalled();
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
