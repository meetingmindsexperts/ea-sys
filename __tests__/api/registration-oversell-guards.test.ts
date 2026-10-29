/**
 * Oversell guards on the two admin batch paths that increment TicketType.soldCount:
 * bulk-type change (PATCH) and import-contacts (POST). Both must claim seats with
 * the atomic `soldCount <= quantity - N` predicate so a concurrent batch / public
 * registration can't push soldCount past quantity. Over capacity → 409 (all-or-
 * nothing), never a silent oversell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// Row locks are Postgres FOR UPDATE; a mocked transaction cannot take them.
// Pinned against the real database in
// tests/integration-db/registration-row-lock.db.test.ts.
const { mockLockRegistrationRows, mockLockRegistrationIfUnchanged } = vi.hoisted(() => ({
  mockLockRegistrationRows: vi.fn(async () => undefined),
  mockLockRegistrationIfUnchanged: vi.fn(async (): Promise<"unchanged" | "changed" | "gone"> => "unchanged"),
}));
vi.mock("@/lib/registration-row-lock", () => ({
  lockRegistrationRows: mockLockRegistrationRows,
  lockRegistrationIfUnchanged: mockLockRegistrationIfUnchanged,
}));
// The per-person lock is an advisory lock in Postgres; a mocked transaction
// cannot take it. Its behaviour is pinned against the real database in
// tests/integration-db/registration-email-lock.db.test.ts.
const { mockLockRegistrationEmails } = vi.hoisted(() => ({ mockLockRegistrationEmails: vi.fn(async () => undefined) }));
vi.mock("@/lib/registration-email-lock", () => ({ lockRegistrationEmails: mockLockRegistrationEmails }));
import { rawClaims, seatRawExecutor } from "../helpers/raw-seat-sql";

const { mockDb, mockAuth } = vi.hoisted(() => {
  // Who is already registered is read inside the transaction now (behind the
  // per-person lock); one function serves both handles.
  const attendeeFindMany = vi.fn();
  const registrationFindMany = vi.fn();
  const tx = {
    ticketType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn(), findUnique: vi.fn() },
    event: {
      findUnique: vi.fn().mockResolvedValue({ seatCount: 0, maxAttendees: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn(async () => 1),
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    registration: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: "reg" }), findMany: registrationFindMany },
    attendee: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: "att" }), findMany: attendeeFindMany },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      registration: { findMany: registrationFindMany },
      attendee: { findMany: attendeeFindMany },
      contact: { findMany: vi.fn() },
      auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockAuth: vi.fn(),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // tenantTransaction with the flag off IS db.$transaction — delegate so the
  // test's tx interception keeps working for the migrated import-contacts site.
  tenantTransaction: (fn: (t: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 1) }));

import { PATCH as bulkType } from "@/app/api/events/[eventId]/registrations/bulk-type/route";
import { POST as importContacts } from "@/app/api/events/[eventId]/registrations/import-contacts/route";

const params = Promise.resolve({ eventId: "ev1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
function req(body: unknown) {
  return new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
});

describe("bulk-type — soldCount oversell guard", () => {
  beforeEach(() => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "T", name: "Physician", quantity: 100 });
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", ticketTypeId: "old", attendeeId: "a1", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD" },
      { id: "r2", ticketTypeId: "old", attendeeId: "a2", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 2 });
    mockDb._tx.pricingTier.updateMany.mockResolvedValue({ count: 1 });
    mockDb._tx.$executeRaw.mockImplementation(seatRawExecutor());
  });

  // Oct 22, 2026 (review M): never ONTO the speakers' type, like create and the single edit.
  it("refuses the speakers' Faculty type as a target, before any registration is read or moved", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "F", name: "Faculty", quantity: 999999, isFaculty: true });
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "F" }), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TICKET_TYPE_IS_FACULTY" });
    expect(mockDb.registration.findMany).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("claims seats atomically with the capacity predicate (one guarded statement)", async () => {
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(rawClaims(mockDb._tx.$executeRaw, "TicketType")).toEqual([{ id: "T", count: 2 }]);
  });

  it("locks the rows, then reads them inside the transaction, uncategorised rows included (Oct 29, 2026)", async () => {
    await bulkType(req({ registrationIds: ["r2", "r1"], ticketTypeId: "T" }), { params });
    expect(mockLockRegistrationRows).toHaveBeenCalledWith(expect.anything(), "ev1", ["r2", "r1"]);
    expect(mockLockRegistrationRows.mock.invocationCallOrder[0]).toBeLessThan(mockDb.registration.findMany.mock.invocationCallOrder[0]);
    // `not` alone drops NULL in SQL, which left rows with no type unmovable.
    expect(mockDb.registration.findMany.mock.calls[0][0].where.OR).toEqual([{ ticketTypeId: null }, { ticketTypeId: { not: "T" } }]);
  });

  it("a PUBLIC+TIER reg releases its TIER counter AND the old type (the ceiling), then claims the new type (P1.1)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r3", ticketTypeId: "old", attendeeId: "a3", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: "pt_old", createdSource: "PUBLIC_REGISTER" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
    // The applier reads the tier's parent to release the ceiling as well.
    mockDb._tx.pricingTier.findUnique.mockResolvedValue({ ticketTypeId: "old" });
    const res = await bulkType(req({ registrationIds: ["r3"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    // released the old TYPE first (lock order), then the tier
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith({
      where: { id: "old", soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    expect(mockDb._tx.pricingTier.updateMany).toHaveBeenCalledWith({
      where: { id: "pt_old", soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    // claimed the new ticket type
    expect(rawClaims(mockDb._tx.$executeRaw, "TicketType")).toEqual([{ id: "T", count: 1 }]);
    // the moved row's stale tier is nulled
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketTypeId: "T", pricingTierId: null }) }),
    );
  });

  it("returns 409 CAPACITY_EXCEEDED and does NOT move registrations when over capacity", async () => {
    mockDb._tx.$executeRaw.mockImplementation(seatRawExecutor({ TicketType: false }));
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CAPACITY_EXCEEDED");
    expect(mockDb._tx.registration.updateMany).not.toHaveBeenCalled();
  });

  // ── H8 (July 10 review): the bulk move must re-stamp originalPrice for
  //    money-outstanding rows — readRegistrationBasePrice PREFERS the stamped
  //    value, so without this a $100-type reg moved to a $400 type kept
  //    charging $100 everywhere. Settled rows keep their paid price (exact
  //    parity with resolveRepricing's bare-type-change policy).
  it("re-stamps originalPrice to the NEW type's base for unpaid rows; settled rows keep theirs", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "T", name: "Physician", quantity: 100, price: 400 });
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", ticketTypeId: "old", attendeeId: "a1", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "UNPAID" },
      { id: "r2", ticketTypeId: "old", attendeeId: "a2", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "UNASSIGNED" },
      { id: "r3", ticketTypeId: "old", attendeeId: "a3", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "PAID" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });

    const res = await bulkType(req({ registrationIds: ["r1", "r2", "r3"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);

    // Unpaid group: moved + repriced to the new base. Event-bound (tenancy C1)
    // so a crafted id list can't move another event's rows.
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2"] }, eventId: "ev1" },
      data: { ticketTypeId: "T", pricingTierId: null, originalPrice: 400 },
    });
    // Settled group: moved, price untouched (they already paid it).
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r3"] }, eventId: "ev1" },
      data: { ticketTypeId: "T", pricingTierId: null },
    });
  });

  // Owner, Oct 26, 2026: moving onto the Exhibitor type sets the badge type,
  // on both the unpaid and the settled update.
  it("moving onto the type named Exhibitor writes badgeType Exhibitor on every moved row", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "X", name: "Exhibitor", quantity: 100, price: 0 });
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r1", ticketTypeId: "old", attendeeId: "a1", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "UNPAID" },
      { id: "r3", ticketTypeId: "old", attendeeId: "a3", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "PAID" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });

    const res = await bulkType(req({ registrationIds: ["r1", "r3"], ticketTypeId: "X" }), { params });
    expect(res.status).toBeLessThan(400);
    const datas = mockDb._tx.registration.updateMany.mock.calls.map((c) => c[0].data as Record<string, unknown>);
    expect(datas).toHaveLength(2);
    for (const d of datas) expect(d.badgeType).toBe("Exhibitor");
  });

  it("all-settled batch never writes originalPrice", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "T", name: "Physician", quantity: 100, price: 400 });
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r4", ticketTypeId: "old", attendeeId: "a4", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: null, createdSource: "ADMIN_DASHBOARD", paymentStatus: "COMPLIMENTARY" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });

    const res = await bulkType(req({ registrationIds: ["r4"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledTimes(1);
    const data = mockDb._tx.registration.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.originalPrice).toBeUndefined();
  });
});

describe("import-contacts — soldCount oversell guard", () => {
  beforeEach(() => {
    mockDb.contact.findMany.mockResolvedValue([
      { id: "c1", email: "a@x.com", firstName: "A", lastName: "X" },
      { id: "c2", email: "b@x.com", firstName: "B", lastName: "X" },
    ]);
    mockDb.attendee.findMany.mockResolvedValue([]); // none existing → both toCreate
  });

  it("returns 409 CAPACITY_EXCEEDED when the batch won't fit", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "T", soldCount: 99, quantity: 100 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 0 }); // 1 seat left, importing 2
    const res = await importContacts(req({ contactIds: ["c1", "c2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CAPACITY_EXCEEDED");
  });

  it("claims with the capacity predicate when it fits", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({ id: "T", soldCount: 0, quantity: 100 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
    const res = await importContacts(req({ contactIds: ["c1", "c2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "T", soldCount: { lte: 98 } }, data: { soldCount: { increment: 2 } } }),
    );
  });
});
