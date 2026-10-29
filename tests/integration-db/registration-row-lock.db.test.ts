/**
 * Seat moves on EXISTING registrations, under concurrency, on a REAL Postgres
 * (Oct 29, 2026). The bulk paths used to read their rows before the
 * transaction and the single edit took its counters before its row, so a
 * cancel landing in between was released twice. A mocked Prisma has one fake
 * connection and cannot show it; here the single edit and the agent's bulk
 * cancel race on one registration and the counters move exactly once.
 *
 * The post-commit fan-out is mocked: nothing here may reach SES or Stripe.
 *
 * Run: docker compose --profile crm-test up -d
 *      INTEGRATION_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test npm run test:integration-db
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendRegistrationConfirmation: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn(async () => undefined) }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/checkout-session-cleanup", () => ({ expireOpenCheckoutSessionOnCancel: vi.fn(async () => undefined) }));

import { db } from "@/lib/db";
import { createRegistration, updateRegistration } from "@/services/registration-service";
import { REGISTRATION_EXECUTORS } from "@/lib/agent/tools/registrations";
import { lockRegistrationIfUnchanged, lockRegistrationRows } from "@/lib/registration-row-lock";
import { resetCrm, type CrmSeed } from "./helper";

let seed: CrmSeed;

async function seedRegistration() {
  const event = await db.event.create({
    data: {
      organizationId: seed.orgId,
      name: "Row Lock Event",
      slug: `row-lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-12-01"),
      endDate: new Date("2026-12-02"),
    },
    select: { id: true },
  });
  const type = await db.ticketType.create({
    data: { eventId: event.id, name: "Physician", price: 0, quantity: 100 },
    select: { id: true },
  });
  const created = await createRegistration({
    eventId: event.id,
    organizationId: seed.orgId,
    userId: seed.userId,
    ticketTypeId: type.id,
    attendee: { email: "row@test.local", firstName: "Row", lastName: "Lock" },
    source: "rest",
  });
  if (!created.ok) throw new Error(created.code);
  // Other people's seats, so a double release shows (the guard stops only at 0).
  await db.ticketType.update({ where: { id: type.id }, data: { soldCount: 5 } });
  await db.event.update({ where: { id: event.id }, data: { seatCount: 5 } });
  return { eventId: event.id, typeId: type.id, registrationId: created.registration.id };
}

async function counters(eventId: string, typeId: string) {
  const [type, event] = await Promise.all([
    db.ticketType.findUniqueOrThrow({ where: { id: typeId }, select: { soldCount: true } }),
    db.event.findUniqueOrThrow({ where: { id: eventId }, select: { seatCount: true } }),
  ]);
  return { soldCount: type.soldCount, seatCount: event.seatCount };
}

beforeEach(async () => {
  seed = await resetCrm();
});

// Fire-and-forget writes (audit rows) must land before the next reset
// truncates, or Postgres reports the race as a deadlock.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 50; i++) {
    const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'`;
    if (Number(n) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
});

describe("cancel races on one registration", () => {
  it("a single edit and the agent's bulk cancel at once: the seat is released once", async () => {
    const { eventId, typeId, registrationId } = await seedRegistration();
    const ctx = { eventId, organizationId: seed.orgId, userId: seed.userId, source: "mcp" as const, counters: { creates: 0, emailsSent: 0 } } as never;

    const results = await Promise.allSettled([
      updateRegistration({ eventId, registrationId, organizationId: seed.orgId, actorUserId: seed.userId, source: "rest", status: "CANCELLED" }),
      REGISTRATION_EXECUTORS.bulk_update_registration_status({ registrationIds: [registrationId], status: "CANCELLED" }, ctx),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const row = await db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { status: true } });
    expect(row.status).toBe("CANCELLED");
    // 5 seats, this one released exactly once.
    expect(await counters(eventId, typeId)).toEqual({ soldCount: 4, seatCount: 4 });
  });
});

describe("registration row locks", () => {
  it("lockRegistrationIfUnchanged: unchanged, changed after a write, gone after a delete", async () => {
    const { registrationId } = await seedRegistration();
    const read = await db.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { updatedAt: true } });
    expect(await db.$transaction((tx) => lockRegistrationIfUnchanged(tx, registrationId, read.updatedAt))).toBe("unchanged");
    await db.registration.update({ where: { id: registrationId }, data: { notes: "edited" } });
    expect(await db.$transaction((tx) => lockRegistrationIfUnchanged(tx, registrationId, read.updatedAt))).toBe("changed");
    await db.registration.delete({ where: { id: registrationId } });
    expect(await db.$transaction((tx) => lockRegistrationIfUnchanged(tx, registrationId, read.updatedAt))).toBe("gone");
  });

  it("lockRegistrationRows holds the rows: a write to one waits for the commit", async () => {
    const { eventId, registrationId } = await seedRegistration();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const outer = db.$transaction(async (tx) => {
      await lockRegistrationRows(tx, eventId, [registrationId, "not-a-registration"]);
      locked();
      await hold;
    });
    await isLocked;

    let written = false;
    const write = db.registration.update({ where: { id: registrationId }, data: { notes: "waited" } }).then(() => (written = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(written).toBe(false);
    release();
    await outer;
    await write;
    expect(written).toBe(true);
  });
});
