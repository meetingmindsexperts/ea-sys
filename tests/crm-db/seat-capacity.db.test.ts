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
  incrementEventSeatsOverselling,
  releaseEventSeats,
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
