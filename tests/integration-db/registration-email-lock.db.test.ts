/**
 * One registration per person per event, under concurrency, on a REAL
 * Postgres (Oct 29, 2026). Nothing in the schema enforces it (Attendee's email
 * unique was dropped on Mar 30, 2026) and transactions run at READ COMMITTED,
 * so a mocked Prisma cannot show the race: two creates both read "none" and
 * both commit. Here several creates for one email start together and exactly
 * one lands, with one seat taken; and the batch form of the lock really holds
 * every key until commit.
 *
 * The post-commit fan-out (email, contact sync, notifications, stats) is
 * mocked: nothing here may reach SES.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import { db } from "@/lib/db";
import { createRegistration } from "@/services/registration-service";
import { lockRegistrationEmails, registrationEmailLockKey } from "@/lib/registration-email-lock";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;

async function seedEvent() {
  const event = await db.event.create({
    data: {
      organizationId: seed.orgId,
      name: "Lock Test Event",
      slug: `lock-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-12-01"),
      endDate: new Date("2026-12-02"),
    },
    select: { id: true },
  });
  const ticketType = await db.ticketType.create({
    data: { eventId: event.id, name: "Physician", price: 0, quantity: 100 },
    select: { id: true },
  });
  return { eventId: event.id, ticketTypeId: ticketType.id };
}

const create = (eventId: string, ticketTypeId: string, email: string) =>
  createRegistration({
    eventId,
    organizationId: seed.orgId,
    userId: seed.userId,
    ticketTypeId,
    attendee: { email, firstName: "Race", lastName: "Tester" },
    source: "rest",
  });

beforeEach(async () => {
  seed = await resetCrm();
});

describe("one registration per person per event", () => {
  it("six concurrent creates for one email (mixed case): exactly one lands, one seat taken", async () => {
    const { eventId, ticketTypeId } = await seedEvent();
    const emails = ["race@test.local", "RACE@test.local", "Race@Test.Local", "race@test.local", "race@TEST.local", "race@test.local"];
    const results = await Promise.all(emails.map((e) => create(eventId, ticketTypeId, e)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? null : r.code))).toEqual(Array(5).fill("ALREADY_REGISTERED"));
    expect(await db.registration.count({ where: { eventId } })).toBe(1);
    const type = await db.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId }, select: { soldCount: true } });
    expect(type.soldCount).toBe(1);
  });

  it("different people on the same event are not held up by each other's lock", async () => {
    const { eventId, ticketTypeId } = await seedEvent();
    const results = await Promise.all(["a@test.local", "b@test.local", "c@test.local"].map((e) => create(eventId, ticketTypeId, e)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await db.registration.count({ where: { eventId } })).toBe(3);
  });

  it("the same email on two events registers on both", async () => {
    const one = await seedEvent();
    const two = await seedEvent();
    const [a, b] = await Promise.all([create(one.eventId, one.ticketTypeId, "x@test.local"), create(two.eventId, two.ticketTypeId, "x@test.local")]);
    expect(a.ok && b.ok).toBe(true);
  });
});

describe("lockRegistrationEmails", () => {
  it("the batch form holds every key until commit (one round trip)", async () => {
    const { eventId } = await seedEvent();
    let releaseOuter!: () => void;
    const outerHolds = new Promise<void>((resolve) => (releaseOuter = resolve));
    let locked!: () => void;
    const lockedNow = new Promise<void>((resolve) => (locked = resolve));

    const outer = db.$transaction(async (tx) => {
      await lockRegistrationEmails(tx, eventId, ["b@test.local", "A@test.local", "c@test.local", "a@test.local"]);
      locked();
      await outerHolds;
    });
    await lockedNow;

    // Seen from another connection: three distinct keys held, duplicates and case folded.
    const held = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted
        AND objid IN (
          SELECT (hashtext(k)::bigint & 4294967295)::oid
          FROM unnest(${["a", "b", "c"].map((p) => registrationEmailLockKey(eventId, `${p}@test.local`))}::text[]) AS k
        )`;
    expect(Number(held[0].n)).toBe(3);

    // A second transaction for one of those people waits until the first commits.
    let secondDone = false;
    const second = db.$transaction(async (tx) => {
      await lockRegistrationEmails(tx, eventId, ["c@test.local"]);
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondDone).toBe(false);
    releaseOuter();
    await outer;
    await second;
    expect(secondDone).toBe(true);
  });
});
