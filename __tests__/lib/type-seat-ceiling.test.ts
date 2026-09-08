/**
 * The ticket type's seat limit is a hard ceiling over all of its pricing tiers
 * (owner decision Sep 8, 2026, after a 35-seat type sold 107 through a tier
 * whose own limit was empty). The rule lives in ONE place, the seat appliers:
 * a tier claim is also claimed on the tier's ticket type, a tier release is
 * also released there, and the unguarded bulk claim moves both. Every caller
 * that already used the appliers got the ceiling without changing.
 *
 * Only `tx` is mocked; the appliers are the real code.
 */
import { describe, it, expect, vi } from "vitest";
import { claimSeats, claimSeatsOverselling, releaseSeats } from "@/lib/registration-seat-db";

type Call = { where: Record<string, unknown>; data: Record<string, unknown> };

function makeTx(opts: {
  tier?: { quantity: number; soldCount?: number; name?: string; ticketTypeId?: string | null } | null;
  type?: { quantity: number; soldCount?: number; name?: string } | null;
  tierClaimFits?: boolean;
  typeClaimFits?: boolean;
} = {}) {
  const tierCalls: Call[] = [];
  const typeCalls: Call[] = [];
  const tier = opts.tier === undefined ? { quantity: 999999, ticketTypeId: "tt1" } : opts.tier;
  const type = opts.type === undefined ? { quantity: 35 } : opts.type;
  const tx = {
    pricingTier: {
      findUnique: vi.fn().mockResolvedValue(tier),
      updateMany: vi.fn().mockImplementation((a: Call) => {
        tierCalls.push(a);
        const isClaim = JSON.stringify(a.data).includes("increment");
        return Promise.resolve({ count: isClaim ? (opts.tierClaimFits === false ? 0 : 1) : 1 });
      }),
    },
    ticketType: {
      findUnique: vi.fn().mockResolvedValue(type),
      updateMany: vi.fn().mockImplementation((a: Call) => {
        typeCalls.push(a);
        const isClaim = JSON.stringify(a.data).includes("increment");
        return Promise.resolve({ count: isClaim ? (opts.typeClaimFits === false ? 0 : 1) : 1 });
      }),
    },
  };
  return { tx: tx as unknown as Parameters<typeof claimSeats>[0], tierCalls, typeCalls };
}

const TIER = { kind: "tier" as const, id: "pt1" };

describe("claimSeats on a tier — the type is the ceiling", () => {
  it("claims the tier's own limit AND the ticket type's limit, both guarded", async () => {
    const { tx, tierCalls, typeCalls } = makeTx();
    expect(await claimSeats(tx, TIER, 1)).toBe(true);
    expect(tierCalls).toEqual([
      { where: { id: "pt1", soldCount: { lte: 999998 } }, data: { soldCount: { increment: 1 } } },
    ]);
    expect(typeCalls).toEqual([
      { where: { id: "tt1", soldCount: { lte: 34 } }, data: { soldCount: { increment: 1 } } },
    ]);
  });

  it("refuses when the tier fits but the type is full, and hands the tier seat back", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({ typeClaimFits: false });
    expect(await claimSeats(tx, TIER, 1)).toBe(false);
    // tier: claimed, then released again so the two counters cannot disagree
    expect(tierCalls.map((c) => c.data)).toEqual([
      { soldCount: { increment: 1 } },
      { soldCount: { decrement: 1 } },
    ]);
    expect(tierCalls[1].where).toEqual({ id: "pt1", soldCount: { gte: 1 } });
    expect(typeCalls).toHaveLength(1); // the refused claim only
  });

  it("refuses when the tier itself is full without touching the type", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({ tierClaimFits: false });
    expect(await claimSeats(tx, TIER, 1)).toBe(false);
    expect(tierCalls).toHaveLength(1);
    expect(typeCalls).toHaveLength(0);
  });

  it("claims N seats against both limits (group registration shape)", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({ tier: { quantity: 100, ticketTypeId: "tt1" }, type: { quantity: 40 } });
    expect(await claimSeats(tx, TIER, 5)).toBe(true);
    expect(tierCalls[0].where).toEqual({ id: "pt1", soldCount: { lte: 95 } });
    expect(typeCalls[0].where).toEqual({ id: "tt1", soldCount: { lte: 35 } });
  });

  it("a tier with no parent type cannot claim (fail closed, never fires on real data)", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({ tier: { quantity: 100, ticketTypeId: null } });
    expect(await claimSeats(tx, TIER, 1)).toBe(false);
    expect(tierCalls).toHaveLength(0);
    expect(typeCalls).toHaveLength(0);
  });

  it("a ticket-type counter is claimed on the type only (staff adds, tier-less types)", async () => {
    const { tx, tierCalls, typeCalls } = makeTx();
    expect(await claimSeats(tx, { kind: "ticketType", id: "tt1" }, 1)).toBe(true);
    expect(tierCalls).toHaveLength(0);
    expect(typeCalls).toEqual([
      { where: { id: "tt1", soldCount: { lte: 34 } }, data: { soldCount: { increment: 1 } } },
    ]);
  });
});

describe("releaseSeats on a tier — the type gives the seat back too", () => {
  it("guarded decrement on the tier AND on its ticket type", async () => {
    const { tx, tierCalls, typeCalls } = makeTx();
    await releaseSeats(tx, TIER, 1);
    expect(tierCalls).toEqual([
      { where: { id: "pt1", soldCount: { gte: 1 } }, data: { soldCount: { decrement: 1 } } },
    ]);
    expect(typeCalls).toEqual([
      { where: { id: "tt1", soldCount: { gte: 1 } }, data: { soldCount: { decrement: 1 } } },
    ]);
  });

  it("a deleted tier row still releases nothing on a type it cannot name", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({ tier: null });
    await releaseSeats(tx, TIER, 1);
    expect(tierCalls).toHaveLength(1);
    expect(typeCalls).toHaveLength(0);
  });
});

describe("claimSeatsOverselling on a tier — bulk paths move both, unguarded", () => {
  it("increments tier and type without a guard and reports the TYPE overflow when only the ceiling is exceeded", async () => {
    const { tx, tierCalls, typeCalls } = makeTx({
      tier: { quantity: 999999, soldCount: 10, name: "Standard", ticketTypeId: "tt1" },
      type: { quantity: 35, soldCount: 34, name: "Delegate" },
    });
    const res = await claimSeatsOverselling(tx, TIER, 2);
    expect(tierCalls).toEqual([{ where: { id: "pt1" }, data: { soldCount: { increment: 2 } } }]);
    expect(typeCalls).toEqual([{ where: { id: "tt1" }, data: { soldCount: { increment: 2 } } }]);
    expect(res).toEqual({ oversold: true, counterName: "Delegate", newSoldCount: 36, quantity: 35 });
  });

  it("reports the tier first when both overflow, and no overflow when both fit", async () => {
    const both = makeTx({
      tier: { quantity: 10, soldCount: 10, name: "Early Bird", ticketTypeId: "tt1" },
      type: { quantity: 35, soldCount: 35, name: "Delegate" },
    });
    expect(await claimSeatsOverselling(both.tx, TIER, 1)).toEqual({
      oversold: true, counterName: "Early Bird", newSoldCount: 11, quantity: 10,
    });
    const fits = makeTx({
      tier: { quantity: 100, soldCount: 1, name: "Early Bird", ticketTypeId: "tt1" },
      type: { quantity: 35, soldCount: 1, name: "Delegate" },
    });
    expect(await claimSeatsOverselling(fits.tx, TIER, 1)).toEqual({
      oversold: false, counterName: "Early Bird", newSoldCount: 2, quantity: 100,
    });
  });
});
