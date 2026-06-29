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
    ticketType: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn() },
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
      { id: "r1", ticketTypeId: "old", attendeeId: "a1" },
      { id: "r2", ticketTypeId: "old", attendeeId: "a2" },
    ]);
    mockDb._tx.registration.updateMany.mockResolvedValue({ count: 2 });
  });

  it("claims seats atomically with the capacity predicate", async () => {
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "T", soldCount: { lte: 98 } }, data: { soldCount: { increment: 2 } } }),
    );
  });

  it("returns 409 CAPACITY_EXCEEDED and does NOT move registrations when over capacity", async () => {
    mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 0 });
    const res = await bulkType(req({ registrationIds: ["r1", "r2"], ticketTypeId: "T" }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CAPACITY_EXCEEDED");
    expect(mockDb._tx.registration.updateMany).not.toHaveBeenCalled();
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
