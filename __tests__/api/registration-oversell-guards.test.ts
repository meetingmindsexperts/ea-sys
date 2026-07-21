/**
 * Oversell guards on the two admin batch paths that increment TicketType.soldCount:
 * bulk-type change (PATCH) and import-contacts (POST). Both must claim seats with
 * the atomic `soldCount <= quantity - N` predicate so a concurrent batch / public
 * registration can't push soldCount past quantity. Over capacity → 409 (all-or-
 * nothing), never a silent oversell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => {
  const tx = {
    ticketType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn(), findUnique: vi.fn() },
    pricingTier: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    registration: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: "reg" }) },
    attendee: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({ id: "att" }) },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      registration: { findMany: vi.fn() },
      attendee: { findMany: vi.fn() },
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
vi.mock("@/lib/db", () => ({ db: mockDb }));
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
    // claimSeats re-reads quantity INSIDE the tx (safer than the pre-tx read
    // the route used before the shared-helper consolidation).
    mockDb._tx.ticketType.findUnique.mockResolvedValue({ quantity: 100 });
  });

  it("claims seats atomically with the capacity predicate", async () => {
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "T", soldCount: { lte: 98 } }, data: { soldCount: { increment: 2 } } }),
    );
  });

  it("a PUBLIC+TIER reg releases its TIER counter on the move, claims the new ticket type (P1.1)", async () => {
    mockDb.registration.findMany.mockResolvedValue([
      { id: "r3", ticketTypeId: "old", attendeeId: "a3", status: "CONFIRMED", attendanceMode: "IN_PERSON", pricingTierId: "pt_old", createdSource: "PUBLIC_REGISTER" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 1 });
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
    const res = await bulkType(req({ registrationIds: ["r3"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    // released the TIER (not the old ticket type)
    expect(mockDb._tx.pricingTier.updateMany).toHaveBeenCalledWith({
      where: { id: "pt_old", soldCount: { gte: 1 } },
      data: { soldCount: { decrement: 1 } },
    });
    // claimed the new ticket type
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "T", soldCount: { lte: 99 } }, data: { soldCount: { increment: 1 } } }),
    );
    // the moved row's stale tier is nulled
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ticketTypeId: "T", pricingTierId: null }) }),
    );
  });

  it("returns 409 CAPACITY_EXCEEDED and does NOT move registrations when over capacity", async () => {
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 0 });
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

    // Unpaid group: moved + repriced to the new base.
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2"] } },
      data: { ticketTypeId: "T", pricingTierId: null, originalPrice: 400 },
    });
    // Settled group: moved, price untouched (they already paid it).
    expect(mockDb._tx.registration.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r3"] } },
      data: { ticketTypeId: "T", pricingTierId: null },
    });
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
