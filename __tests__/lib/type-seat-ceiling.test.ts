/**
 * The ticket type's seat limit is a hard ceiling over all of its pricing tiers
 * (owner decision Sep 8, 2026, after a 35-seat type sold 107 through a tier
 * whose own limit was empty). The rule lives in ONE place, the seat appliers:
 * a tier claim is also claimed on the tier's ticket type, a tier release is
 * also released there, and the unguarded bulk claim moves both. Every caller
 * that already used the appliers got the ceiling without changing.
 *
 * Contract pinned here (same-day adversarial review):
 *  - a guarded claim is ONE raw statement, `soldCount + n <= quantity`
 *    compared in SQL, never a read-then-write against a stale quantity;
 *  - lock order is TYPE then TIER on claim and on release;
 *  - a tier refusal hands the type's seats back;
 *  - a move between two tiers of the same type touches the tiers only.
 *
 * Only `tx` is mocked; the appliers are the real code.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HELD_SEAT_WHERE,
  claimSeats,
  claimSeatsOverselling,
  releaseSeats,
} from "@/lib/registration-seat-db";
import { rawClaims, rawSeatCalls, seatRawExecutor } from "../helpers/raw-seat-sql";

type Call = { where: Record<string, unknown>; data: Record<string, unknown> };

function makeTx(opts: {
  tier?: { quantity?: number; soldCount?: number; name?: string; ticketTypeId?: string | null } | null;
  type?: { quantity?: number; soldCount?: number; name?: string } | null;
  tierClaimFits?: boolean;
  typeClaimFits?: boolean;
} = {}) {
  const tierUpdates: Call[] = [];
  const typeUpdates: Call[] = [];
  const tier = opts.tier === undefined ? { ticketTypeId: "tt1" } : opts.tier;
  const type = opts.type === undefined ? { quantity: 35 } : opts.type;
  const $executeRaw = vi.fn(seatRawExecutor({
    PricingTier: opts.tierClaimFits !== false,
    TicketType: opts.typeClaimFits !== false,
  }));
  const tx = {
    $executeRaw,
    pricingTier: {
      findUnique: vi.fn().mockResolvedValue(tier),
      updateMany: vi.fn().mockImplementation((a: Call) => {
        tierUpdates.push(a);
        return Promise.resolve({ count: 1 });
      }),
    },
    ticketType: {
      findUnique: vi.fn().mockResolvedValue(type),
      updateMany: vi.fn().mockImplementation((a: Call) => {
        typeUpdates.push(a);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  return { tx: tx as unknown as Parameters<typeof claimSeats>[0], $executeRaw, tierUpdates, typeUpdates };
}

const TIER = { kind: "tier" as const, id: "pt1" };
const TYPE = { kind: "ticketType" as const, id: "tt1" };

describe("claimSeats on a tier — the type is the ceiling", () => {
  it("claims the TYPE first, then the tier, each as one guarded statement", async () => {
    const { tx, $executeRaw, tierUpdates, typeUpdates } = makeTx();
    expect(await claimSeats(tx, TIER, 1)).toBe(true);
    expect(rawSeatCalls($executeRaw).map((c) => c.table)).toEqual(["TicketType", "PricingTier"]);
    expect(rawClaims($executeRaw, "TicketType")).toEqual([{ id: "tt1", count: 1 }]);
    expect(rawClaims($executeRaw, "PricingTier")).toEqual([{ id: "pt1", count: 1 }]);
    // the guard is in the statement itself, so no Prisma updateMany runs
    expect(tierUpdates).toHaveLength(0);
    expect(typeUpdates).toHaveLength(0);
  });

  it("the claim compares the two columns in SQL (no read-then-write on a stale quantity)", async () => {
    const { tx, $executeRaw } = makeTx();
    await claimSeats(tx, TIER, 3);
    for (const call of rawSeatCalls($executeRaw)) {
      expect(call.sql).toMatch(/"soldCount" \+ \? <= "quantity"/);
      expect(call.sql).toMatch(/SET "soldCount" = "soldCount" \+ \?/);
    }
    // quantity is never read ahead of the write
    expect((tx as unknown as { ticketType: { findUnique: ReturnType<typeof vi.fn> } }).ticketType.findUnique).not.toHaveBeenCalled();
  });

  it("refuses when the TYPE is full and never touches the tier", async () => {
    const { tx, $executeRaw, tierUpdates, typeUpdates } = makeTx({ typeClaimFits: false });
    expect(await claimSeats(tx, TIER, 1)).toBe(false);
    expect(rawSeatCalls($executeRaw).map((c) => c.table)).toEqual(["TicketType"]);
    expect(tierUpdates).toHaveLength(0);
    expect(typeUpdates).toHaveLength(0);
  });

  it("refuses when the tier is full and hands the TYPE's seats back", async () => {
    const { tx, $executeRaw, typeUpdates } = makeTx({ tierClaimFits: false });
    expect(await claimSeats(tx, TIER, 2)).toBe(false);
    expect(rawSeatCalls($executeRaw).map((c) => c.table)).toEqual(["TicketType", "PricingTier"]);
    expect(typeUpdates).toEqual([
      { where: { id: "tt1", soldCount: { gte: 2 } }, data: { soldCount: { decrement: 2 } } },
    ]);
  });

  it("claims N seats against both limits (group registration shape)", async () => {
    const { tx, $executeRaw } = makeTx();
    expect(await claimSeats(tx, TIER, 5)).toBe(true);
    expect(rawClaims($executeRaw, "TicketType")).toEqual([{ id: "tt1", count: 5 }]);
    expect(rawClaims($executeRaw, "PricingTier")).toEqual([{ id: "pt1", count: 5 }]);
  });

  it("a tier with no parent type cannot claim (fail closed, never fires on real data)", async () => {
    const { tx, $executeRaw } = makeTx({ tier: { ticketTypeId: null } });
    expect(await claimSeats(tx, TIER, 1)).toBe(false);
    expect($executeRaw).not.toHaveBeenCalled();
  });

  it("a ticket-type counter is claimed on the type only (staff adds, tier-less types)", async () => {
    const { tx, $executeRaw } = makeTx();
    expect(await claimSeats(tx, TYPE, 1)).toBe(true);
    expect(rawSeatCalls($executeRaw).map((c) => c.table)).toEqual(["TicketType"]);
  });

  it("tierOnly: a move within the same type claims the tier and leaves the type alone", async () => {
    const { tx, $executeRaw, typeUpdates } = makeTx();
    expect(await claimSeats(tx, TIER, 1, { tierOnly: true })).toBe(true);
    expect(rawSeatCalls($executeRaw).map((c) => c.table)).toEqual(["PricingTier"]);
    expect(typeUpdates).toHaveLength(0);
  });
});

describe("releaseSeats on a tier — the type gives the seat back too, type first", () => {
  it("guarded decrement on the TYPE, then on the tier", async () => {
    const { tx, tierUpdates, typeUpdates } = makeTx();
    const order: string[] = [];
    (tx as unknown as { ticketType: { updateMany: ReturnType<typeof vi.fn> } }).ticketType.updateMany.mockImplementation(
      (a: Call) => { typeUpdates.push(a); order.push("type"); return Promise.resolve({ count: 1 }); },
    );
    (tx as unknown as { pricingTier: { updateMany: ReturnType<typeof vi.fn> } }).pricingTier.updateMany.mockImplementation(
      (a: Call) => { tierUpdates.push(a); order.push("tier"); return Promise.resolve({ count: 1 }); },
    );
    await releaseSeats(tx, TIER, 1);
    expect(order).toEqual(["type", "tier"]);
    expect(typeUpdates).toEqual([
      { where: { id: "tt1", soldCount: { gte: 1 } }, data: { soldCount: { decrement: 1 } } },
    ]);
    expect(tierUpdates).toEqual([
      { where: { id: "pt1", soldCount: { gte: 1 } }, data: { soldCount: { decrement: 1 } } },
    ]);
  });

  it("tierOnly: releases the tier only", async () => {
    const { tx, tierUpdates, typeUpdates } = makeTx();
    await releaseSeats(tx, TIER, 1, { tierOnly: true });
    expect(tierUpdates).toHaveLength(1);
    expect(typeUpdates).toHaveLength(0);
  });

  it("a deleted tier row still releases nothing on a type it cannot name", async () => {
    const { tx, tierUpdates, typeUpdates } = makeTx({ tier: null });
    await releaseSeats(tx, TIER, 1);
    expect(tierUpdates).toHaveLength(1);
    expect(typeUpdates).toHaveLength(0);
  });
});

describe("claimSeatsOverselling on a tier — bulk paths move both, unguarded, type first", () => {
  it("increments type then tier without a guard and reports the TYPE overflow when only the ceiling is exceeded", async () => {
    const { tx, tierUpdates, typeUpdates } = makeTx({
      tier: { quantity: 999999, soldCount: 10, name: "Standard", ticketTypeId: "tt1" },
      type: { quantity: 35, soldCount: 34, name: "Delegate" },
    });
    const order: string[] = [];
    (tx as unknown as { ticketType: { updateMany: ReturnType<typeof vi.fn> } }).ticketType.updateMany.mockImplementation(
      (a: Call) => { typeUpdates.push(a); order.push("type"); return Promise.resolve({ count: 1 }); },
    );
    (tx as unknown as { pricingTier: { updateMany: ReturnType<typeof vi.fn> } }).pricingTier.updateMany.mockImplementation(
      (a: Call) => { tierUpdates.push(a); order.push("tier"); return Promise.resolve({ count: 1 }); },
    );
    const res = await claimSeatsOverselling(tx, TIER, 2);
    expect(order).toEqual(["type", "tier"]);
    expect(typeUpdates).toEqual([{ where: { id: "tt1" }, data: { soldCount: { increment: 2 } } }]);
    expect(tierUpdates).toEqual([{ where: { id: "pt1" }, data: { soldCount: { increment: 2 } } }]);
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

  it("a tier with no parent type moves nothing (an undefined id would be an unfiltered updateMany)", async () => {
    const { tx, tierUpdates, typeUpdates } = makeTx({ tier: { quantity: 10, soldCount: 0, name: "X", ticketTypeId: null } });
    const res = await claimSeatsOverselling(tx, TIER, 1);
    expect(res).toEqual({ oversold: false, counterName: null, newSoldCount: null, quantity: null });
    expect(tierUpdates).toHaveLength(0);
    expect(typeUpdates).toHaveLength(0);
  });
});

describe("HELD_SEAT_WHERE — the one row-truth predicate every recount spreads", () => {
  it("is not-cancelled, in-person, not a speaker companion (null createdSource kept IN)", () => {
    expect(HELD_SEAT_WHERE).toEqual({
      status: { not: "CANCELLED" },
      attendanceMode: "IN_PERSON",
      OR: [{ createdSource: null }, { createdSource: { not: "SPEAKER_COMPANION" } }],
    });
  });

  it("the one-time recount migration restates exactly those three predicates", () => {
    const sql = readFileSync(
      path.join(process.cwd(), "prisma/migrations/20260908100000_tickettype_soldcount_is_type_ceiling/migration.sql"),
      "utf8",
    );
    expect(sql).toContain(`r."status" <> 'CANCELLED'`);
    expect(sql).toContain(`r."attendanceMode" = 'IN_PERSON'`);
    expect(sql).toContain(`(r."createdSource" IS NULL OR r."createdSource" <> 'SPEAKER_COMPANION')`);
  });
});
