/**
 * Import Contacts → Registrations: full field carry + typeless import (July 28, 2026).
 *
 * Three properties pinned here:
 *  1. Every person field the org Contact holds (title, specialty, role, city,
 *     tags, member/student IDs, …) lands on the created Attendee — the route
 *     used to copy only 7 fields and silently drop the rest.
 *  2. Registration type is OPTIONAL (CSV-importer parity, "never guess"):
 *     absent ⇒ ticketTypeId null, paymentStatus COMPLIMENTARY, no ticket-type
 *     seat claim, originalPrice unstamped; faculty types are refused; a tier
 *     without a type is a 400.
 *  3. The typed path keeps its pre-existing shape (seat claim + originalPrice
 *     stamp + name mirror onto attendee.registrationType).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => {
  const tx = {
    ticketType: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    event: {
      findUnique: vi.fn().mockResolvedValue({ seatCount: 0, maxAttendees: null }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    registration: { create: vi.fn().mockResolvedValue({ id: "reg" }) },
    attendee: { create: vi.fn().mockResolvedValue({ id: "att" }) },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      ticketType: { findFirst: vi.fn() },
      pricingTier: { findFirst: vi.fn() },
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
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (t: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: vi.fn(async () => 7) }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));

import { POST as importContacts } from "@/app/api/events/[eventId]/registrations/import-contacts/route";

const params = Promise.resolve({ eventId: "ev1" });
const session = { user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } };
function req(body: unknown) {
  return new Request("http://localhost/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const richContact = {
  id: "c1",
  email: "a@x.com",
  firstName: "Amina",
  lastName: "Khan",
  title: "DR",
  role: "PHYSICIAN",
  organization: "Cleveland Clinic",
  jobTitle: "Consultant",
  phone: "+9715551234",
  additionalEmail: "amina.alt@x.com",
  bio: "Bio text",
  specialty: "Cardiology",
  customSpecialty: null,
  registrationType: "Physician",
  photo: "/uploads/photos/2026/07/a.png",
  city: "Dubai",
  state: "DXB",
  zipCode: "00000",
  country: "AE",
  associationName: "ESC",
  memberId: "M-1",
  studentId: null,
  studentIdExpiry: null,
  tags: ["committee", "vip"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(session);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.contact.findMany.mockResolvedValue([richContact]);
  mockDb.attendee.findMany.mockResolvedValue([]); // no existing → creates
  mockDb._tx.event.findUnique.mockResolvedValue({ seatCount: 0, maxAttendees: null });
  mockDb._tx.ticketType.updateMany.mockResolvedValue({ count: 1 });
});

describe("import-contacts — full contact field carry", () => {
  it("copies title, specialty, role and every other person field to the attendee", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      id: "T", name: "Delegate", price: 100, quantity: 999, requiresApproval: false, isFaculty: false,
    });
    const res = await importContacts(req({ contactIds: ["c1"], ticketTypeId: "T" }), { params });
    expect(res.status).toBe(200);

    const data = mockDb._tx.attendee.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.title).toBe("DR");
    expect(data.role).toBe("PHYSICIAN");
    expect(data.specialty).toBe("Cardiology");
    expect(data.bio).toBe("Bio text");
    expect(data.photo).toBe("/uploads/photos/2026/07/a.png");
    expect(data.additionalEmail).toBe("amina.alt@x.com");
    expect(data.city).toBe("Dubai");
    expect(data.state).toBe("DXB");
    expect(data.zipCode).toBe("00000");
    expect(data.country).toBe("AE");
    expect(data.associationName).toBe("ESC");
    expect(data.memberId).toBe("M-1");
    expect(data.tags).toEqual(["committee", "vip"]);
    // ticketTypeId is the source of truth — the free-text mirror shows the
    // PICKED type's name, not the contact's stale category text.
    expect(data.registrationType).toBe("Delegate");
  });

  it("stamps originalPrice and claims the ticket-type seat on the typed path", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      id: "T", name: "Delegate", price: 100, quantity: 50, requiresApproval: false, isFaculty: false,
    });
    const res = await importContacts(req({ contactIds: ["c1"], ticketTypeId: "T" }), { params });
    expect(res.status).toBe(200);

    const regData = mockDb._tx.registration.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(regData.ticketTypeId).toBe("T");
    expect(regData.originalPrice).toBe(100);
    expect(regData.paymentStatus).toBeUndefined(); // typed rows keep schema defaults
    expect(mockDb._tx.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "T", soldCount: { lte: 49 } } }),
    );
  });
});

describe("import-contacts — typeless (uncategorised) import", () => {
  it("imports without a registration type: null ticketTypeId, COMPLIMENTARY, no seat claim", async () => {
    const res = await importContacts(req({ contactIds: ["c1"] }), { params });
    expect(res.status).toBe(200);

    const regData = mockDb._tx.registration.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(regData.ticketTypeId).toBeNull();
    expect(regData.paymentStatus).toBe("COMPLIMENTARY"); // nothing to owe without a price
    expect(regData.originalPrice).toBeNull(); // no price to stamp
    // No ticket-type counter to move — but the event-wide counter still counts them.
    expect(mockDb._tx.ticketType.updateMany).not.toHaveBeenCalled();
    expect(mockDb._tx.event.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { seatCount: { increment: 1 } } }),
    );

    // The attendee's free-text mirror falls back to the contact's own category.
    const attData = mockDb._tx.attendee.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(attData.registrationType).toBe("Physician");

    expect(await res.json()).toMatchObject({ created: 1, uncategorised: 1 });
  });

  it("refuses the hidden Faculty type", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue({
      id: "F", name: "Faculty", price: 0, quantity: 999999, requiresApproval: false, isFaculty: true,
    });
    const res = await importContacts(req({ contactIds: ["c1"], ticketTypeId: "F" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TICKET_TYPE_IS_FACULTY");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a ticket type that doesn't belong to the event", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const res = await importContacts(req({ contactIds: ["c1"], ticketTypeId: "other" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TICKET_TYPE_NOT_FOUND");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a pricing tier sent without a registration type", async () => {
    const res = await importContacts(req({ contactIds: ["c1"], pricingTierId: "tier1" }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TIER_WITHOUT_TYPE");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
