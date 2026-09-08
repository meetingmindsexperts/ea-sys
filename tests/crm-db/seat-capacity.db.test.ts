/**
 * Event-wide seat capacity (Option B) — REAL-Postgres integration tests.
 *
 * Lives in the shared real-Postgres harness project (tests/crm-db — the name
 * predates non-CRM suites; it is the general "mocks can't verify this" DB
 * harness). These pin the things the mocked unit suite structurally cannot:
 *
 *  - `claimEventSeats` is a RAW conditional UPDATE comparing two columns
 *    (`seatCount + n <= maxAttendees`) — the SQL itself never executes under
 *    the mocked suite, so a typo'd column name / wrong predicate would pass
 *    unit tests and fail only in prod.
 *  - The atomicity claim: N concurrent claims against a cap of K admit
 *    EXACTLY K (no oversell, no double-count) under real Postgres locking.
 *  - Guarded release floors at 0 in real SQL.
 *  - `applyRegistrationTransition` moves the real Event.seatCount alongside
 *    the real TicketType.soldCount inside one committed transaction.
 *
 * Run: docker compose --profile crm-test up -d
 *      CRM_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:crm-db
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  applyRegistrationTransition,
  claimEventSeats,
  claimSeats,
  incrementEventSeatsOverselling,
  releaseEventSeats,
  releaseSeats,
} from "@/lib/registration-seat-db";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;

async function seedEvent(maxAttendees: number | null) {
  const event = await db.event.create({
    data: {
      organizationId: seed.orgId,
      name: "Cap Test Event",
      slug: `cap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-09-02"),
      maxAttendees,
      seatCount: 0,
    },
    select: { id: true },
  });
  const ticketType = await db.ticketType.create({
    data: { eventId: event.id, name: "Physician", price: 0, quantity: 999999 },
    select: { id: true },
  });
  return { eventId: event.id, ticketTypeId: ticketType.id };
}

async function readSeatCount(eventId: string): Promise<number> {
  const row = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { seatCount: true } });
  return row.seatCount;
}

beforeEach(async () => {
  seed = await resetCrm();
});

describe("claimEventSeats — raw conditional claim against the cap", () => {
  it("admits exactly maxAttendees claims, then blocks", async () => {
    const { eventId } = await seedEvent(2);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(true);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(true);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(false); // full
    expect(await readSeatCount(eventId)).toBe(2); // the failed claim moved nothing
  });

  it("null maxAttendees (unlimited) increments but never blocks", async () => {
    const { eventId } = await seedEvent(null);
    for (let i = 0; i < 5; i++) {
      expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(true);
    }
    expect(await readSeatCount(eventId)).toBe(5);
  });

  it("CONCURRENCY: 10 simultaneous claims against a cap of 5 admit exactly 5", async () => {
    const { eventId } = await seedEvent(5);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.$transaction((tx) => claimEventSeats(tx, eventId))),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await readSeatCount(eventId)).toBe(5); // never oversold, never double-counted
  });

  it("a failed claim inside a rolled-back tx leaves the counter untouched", async () => {
    const { eventId } = await seedEvent(1);
    await db.$transaction((tx) => claimEventSeats(tx, eventId));
    await expect(
      db.$transaction(async (tx) => {
        const ok = await claimEventSeats(tx, eventId);
        if (!ok) throw new Error("EVENT_FULL");
      }),
    ).rejects.toThrow("EVENT_FULL");
    expect(await readSeatCount(eventId)).toBe(1);
  });
});

describe("releaseEventSeats — guarded decrement", () => {
  it("frees a seat that a new claim can take", async () => {
    const { eventId } = await seedEvent(1);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(true);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(false);
    await db.$transaction((tx) => releaseEventSeats(tx, eventId));
    expect(await readSeatCount(eventId)).toBe(0);
    expect(await db.$transaction((tx) => claimEventSeats(tx, eventId))).toBe(true); // seat reusable
  });

  it("NEVER goes below 0 (release on an empty counter no-ops)", async () => {
    const { eventId } = await seedEvent(10);
    await db.$transaction((tx) => releaseEventSeats(tx, eventId, 3));
    expect(await readSeatCount(eventId)).toBe(0);
  });
});

describe("incrementEventSeatsOverselling — the imports-bypass posture", () => {
  it("proceeds past the cap and reports the oversell", async () => {
    const { eventId } = await seedEvent(2);
    await db.$transaction((tx) => claimEventSeats(tx, eventId, 2));
    const res = await db.$transaction((tx) => incrementEventSeatsOverselling(tx, eventId, 3));
    expect(res.oversold).toBe(true);
    expect(res.maxAttendees).toBe(2);
    expect(await readSeatCount(eventId)).toBe(5); // counter stays TRUE even over cap
  });

  it("within the cap → not oversold", async () => {
    const { eventId } = await seedEvent(10);
    const res = await db.$transaction((tx) => incrementEventSeatsOverselling(tx, eventId, 3));
    expect(res.oversold).toBe(false);
    expect(await readSeatCount(eventId)).toBe(3);
  });
});

describe("applyRegistrationTransition — event counter rides the real transaction", () => {
  it("cancel releases BOTH the ticket seat and the event seat; reactivate re-claims both", async () => {
    const { eventId, ticketTypeId } = await seedEvent(10);
    // Simulate a created in-person registration holding one seat on each counter.
    await db.ticketType.update({ where: { id: ticketTypeId }, data: { soldCount: 1 } });
    await db.event.update({ where: { id: eventId }, data: { seatCount: 1 } });

    const seatFields = {
      attendanceMode: "IN_PERSON" as const,
      ticketTypeId,
      pricingTierId: null,
      createdSource: "ADMIN_DASHBOARD" as const,
    };

    await db.$transaction((tx) =>
      applyRegistrationTransition(tx, {
        prev: { status: "CONFIRMED", ...seatFields },
        next: { status: "CANCELLED", ...seatFields },
        eventId,
      }),
    );
    expect(await readSeatCount(eventId)).toBe(0);
    const tt = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId }, select: { soldCount: true } });
    expect(tt.soldCount).toBe(0);

    await db.$transaction((tx) =>
      applyRegistrationTransition(tx, {
        prev: { status: "CANCELLED", ...seatFields },
        next: { status: "CONFIRMED", ...seatFields },
        eventId,
      }),
    );
    expect(await readSeatCount(eventId)).toBe(1);
  });

  it("reactivating into a FULL event throws EVENT_FULL and rolls the whole tx back", async () => {
    const { eventId, ticketTypeId } = await seedEvent(1);
    await db.event.update({ where: { id: eventId }, data: { seatCount: 1 } }); // full
    const seatFields = {
      attendanceMode: "IN_PERSON" as const,
      ticketTypeId,
      pricingTierId: null,
      createdSource: "ADMIN_DASHBOARD" as const,
    };
    await expect(
      db.$transaction((tx) =>
        applyRegistrationTransition(tx, {
          prev: { status: "CANCELLED", ...seatFields },
          next: { status: "CONFIRMED", ...seatFields },
          eventId,
        }),
      ),
    ).rejects.toThrow("EVENT_FULL");
    // The ticket-seat claim inside the SAME failed tx rolled back — no leak.
    const tt = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId }, select: { soldCount: true } });
    expect(tt.soldCount).toBe(0);
    expect(await readSeatCount(eventId)).toBe(1);
  });
});

/**
 * The ticket type's seat limit is a hard ceiling over all of its pricing tiers
 * (Sep 8, 2026). A tier claim is claimed on the tier AND on its type in one
 * transaction; the mocked suite pins the call shapes, this pins that real
 * Postgres locking admits exactly the ceiling under concurrency and that a
 * refused claim leaves BOTH counters untouched.
 */
describe("type seat limit — the ceiling over its tiers (real locking)", () => {
  async function seedTypeWithTier(typeQuantity: number, tierQuantity = 999999) {
    const { eventId } = await seedEvent(null);
    const type = await db.ticketType.create({
      data: { eventId, name: "Delegate", price: 0, quantity: typeQuantity },
      select: { id: true },
    });
    const tier = await db.pricingTier.create({
      data: { ticketTypeId: type.id, name: "Standard", price: 0, quantity: tierQuantity, sortOrder: 0 },
      select: { id: true },
    });
    return { eventId, typeId: type.id, tierId: tier.id };
  }
  async function counters(typeId: string, tierId: string) {
    const [t, p] = await Promise.all([
      db.ticketType.findUniqueOrThrow({ where: { id: typeId }, select: { soldCount: true } }),
      db.pricingTier.findUniqueOrThrow({ where: { id: tierId }, select: { soldCount: true } }),
    ]);
    return { type: t.soldCount, tier: p.soldCount };
  }

  it("CONCURRENCY: 10 tier sales against a type limit of 3 (tier unlimited) admit exactly 3", async () => {
    const { typeId, tierId } = await seedTypeWithTier(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.$transaction(async (tx) => {
          const ok = await claimSeats(tx, { kind: "tier", id: tierId }, 1);
          if (!ok) throw new Error("SOLD_OUT");
          return true;
        }).catch(() => false),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    // Both counters read the same 3: the refused claims rolled back cleanly.
    expect(await counters(typeId, tierId)).toEqual({ type: 3, tier: 3 });
  });

  it("the tier's own limit still applies inside the ceiling", async () => {
    const { typeId, tierId } = await seedTypeWithTier(100, 2);
    for (let i = 0; i < 2; i++) {
      expect(await db.$transaction((tx) => claimSeats(tx, { kind: "tier", id: tierId }, 1))).toBe(true);
    }
    expect(await db.$transaction((tx) => claimSeats(tx, { kind: "tier", id: tierId }, 1))).toBe(false);
    expect(await counters(typeId, tierId)).toEqual({ type: 2, tier: 2 });
  });

  it("a tier release frees the seat on the type too, and a staff add then takes it", async () => {
    const { typeId, tierId } = await seedTypeWithTier(1);
    expect(await db.$transaction((tx) => claimSeats(tx, { kind: "tier", id: tierId }, 1))).toBe(true);
    // ceiling reached: a staff add on the type is refused
    expect(await db.$transaction((tx) => claimSeats(tx, { kind: "ticketType", id: typeId }, 1))).toBe(false);
    await db.$transaction((tx) => releaseSeats(tx, { kind: "tier", id: tierId }, 1));
    expect(await counters(typeId, tierId)).toEqual({ type: 0, tier: 0 });
    expect(await db.$transaction((tx) => claimSeats(tx, { kind: "ticketType", id: typeId }, 1))).toBe(true);
    expect(await counters(typeId, tierId)).toEqual({ type: 1, tier: 0 });
  });
});

describe("same-type re-tier on an over-full type (review M3)", () => {
  it("moves the seat between the tiers and leaves the type counter untouched, even above its limit", async () => {
    const { eventId } = await seedEvent(null);
    const type = await db.ticketType.create({
      data: { eventId, name: "Delegate", price: 0, quantity: 35, soldCount: 107 },
      select: { id: true },
    });
    const [standard, earlyBird] = await Promise.all([
      db.pricingTier.create({ data: { ticketTypeId: type.id, name: "Standard", price: 0, quantity: 999999, soldCount: 107, sortOrder: 0 }, select: { id: true } }),
      db.pricingTier.create({ data: { ticketTypeId: type.id, name: "Early Bird", price: 0, quantity: 20, soldCount: 0, sortOrder: 1 }, select: { id: true } }),
    ]);
    const seat = (pricingTierId: string) => ({
      status: "CONFIRMED" as const,
      attendanceMode: "IN_PERSON" as const,
      ticketTypeId: type.id,
      pricingTierId,
      createdSource: "PUBLIC_REGISTER" as const,
    });
    await db.$transaction((tx) =>
      applyRegistrationTransition(tx, { prev: seat(standard.id), next: seat(earlyBird.id), eventId }),
    );
    const [t, s, e] = await Promise.all([
      db.ticketType.findUniqueOrThrow({ where: { id: type.id }, select: { soldCount: true } }),
      db.pricingTier.findUniqueOrThrow({ where: { id: standard.id }, select: { soldCount: true } }),
      db.pricingTier.findUniqueOrThrow({ where: { id: earlyBird.id }, select: { soldCount: true } }),
    ]);
    expect({ type: t.soldCount, standard: s.soldCount, earlyBird: e.soldCount }).toEqual({ type: 107, standard: 106, earlyBird: 1 });
  });
});
