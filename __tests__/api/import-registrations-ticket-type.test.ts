/**
 * Import registration-type resolution (July 27, 2026).
 *
 * The CSV importer used to fall back to `findMany(...)[0]` — an unordered
 * Postgres read whose first row shifts on every UPDATE, and which did not
 * exclude faculty types. On a live event that put 502 imported delegates onto a
 * type named "Faculty" (comp, badged Faculty, and — for the hidden `isFaculty`
 * kind — excluded from every delegate count).
 *
 * These tests pin the replacement rule: the importer NEVER guesses. The row's
 * own cell wins; else the organizer's explicit fallback; else `ticketTypeId`
 * stays null. Faculty is not reachable implicitly from either direction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockApiLogger, mockIncrementEventSeats, mockSerial } = vi.hoisted(() => ({
  mockDb: {
    ticketType: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), create: vi.fn() },
    attendee: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockAuth: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockIncrementEventSeats: vi.fn(),
  mockSerial: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/utils", () => ({ generateBarcode: () => "barcode-1" }));
vi.mock("@/lib/registration-serial", () => ({ getNextSerialId: mockSerial }));
vi.mock("@/lib/registration-seat-db", () => ({
  incrementEventSeatsOverselling: mockIncrementEventSeats,
}));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/webinar", () => ({ readSponsors: () => [] }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordImport: vi.fn() }));

import { POST } from "@/app/api/events/[eventId]/import/registrations/route";
import { resolveImportFallbackTicketType } from "@/lib/import-ticket-type";

const params = { params: Promise.resolve({ eventId: "ev1" }) };

const HEADER = "firstName,lastName,email,registrationType";

function csvRequest(csv: string, defaultTicketTypeId?: string): Request {
  const fd = new FormData();
  fd.append("file", new File([csv], "registrations.csv", { type: "text/csv" }));
  if (defaultTicketTypeId) fd.append("defaultTicketTypeId", defaultTicketTypeId);
  return new Request("http://localhost/api/events/ev1/import/registrations", {
    method: "POST",
    body: fd,
  });
}

const PHYSICIAN = {
  id: "tt-phys",
  name: "Physician",
  price: 0,
  quantity: 999999,
  requiresApproval: false,
  isFaculty: false,
};
const HIDDEN_FACULTY = {
  id: "tt-faculty",
  name: "Faculty",
  price: 0,
  quantity: 999999,
  requiresApproval: false,
  isFaculty: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
  // Faculty deliberately FIRST — this is the heap order that caused the bug.
  mockDb.ticketType.findMany.mockResolvedValue([HIDDEN_FACULTY, PHYSICIAN]);
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.attendee.create.mockResolvedValue({ id: "att-1" });
  mockDb.registration.create.mockResolvedValue({ id: "reg-1" });
  mockDb.ticketType.updateMany.mockResolvedValue({ count: 1 });
  mockSerial.mockResolvedValue(1);
  // Free event by default; the paid-event block below flips this.
  mockDb.ticketType.count.mockResolvedValue(0);
  mockIncrementEventSeats.mockResolvedValue({ oversold: false, newSeatCount: 1, maxAttendees: null });
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb));
});

/** The `data` passed to the single `registration.create` of a one-row import. */
function createdRegistration() {
  expect(mockDb.registration.create).toHaveBeenCalledTimes(1);
  return mockDb.registration.create.mock.calls[0][0].data;
}

describe("resolveImportFallbackTicketType", () => {
  it("returns null (not an error) when no fallback is requested", async () => {
    const res = await resolveImportFallbackTicketType("ev1", null);
    expect(res).toEqual({ ok: true, ticketType: null });
    expect(mockDb.ticketType.findFirst).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace id as no fallback", async () => {
    expect(await resolveImportFallbackTicketType("ev1", "   ")).toEqual({ ok: true, ticketType: null });
  });

  it("rejects a ticket type that does not belong to the event", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(null);
    const res = await resolveImportFallbackTicketType("ev1", "tt-other-event");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TICKET_TYPE_NOT_FOUND");
    // Scoped by event, so a cross-event id can never resolve.
    expect(mockDb.ticketType.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tt-other-event", eventId: "ev1" } })
    );
  });

  it("refuses a faculty type as the import fallback", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(HIDDEN_FACULTY);
    const res = await resolveImportFallbackTicketType("ev1", "tt-faculty");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TICKET_TYPE_IS_FACULTY");
  });

  it("accepts a normal type", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(PHYSICIAN);
    const res = await resolveImportFallbackTicketType("ev1", "tt-phys");
    expect(res).toEqual({ ok: true, ticketType: PHYSICIAN });
  });
});

describe("CSV import — registration type resolution", () => {
  it("leaves ticketTypeId null when the row has no type and no fallback was picked", async () => {
    const res = await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,`), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, errors: [] });
    // The regression: this used to be whatever row Postgres returned first.
    expect(createdRegistration().ticketTypeId).toBeNull();
    // No type ⇒ no ticket-type counter to claim...
    expect(mockDb.ticketType.updateMany).not.toHaveBeenCalled();
    // ...but the person still occupies an event-wide seat.
    expect(mockIncrementEventSeats).toHaveBeenCalledTimes(1);
  });

  it("never invents a ticket type when the event has none", async () => {
    mockDb.ticketType.findMany.mockResolvedValue([]);

    const res = await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,`), params);

    expect(res.status).toBe(200);
    expect(createdRegistration().ticketTypeId).toBeNull();
    // The old code created a placeholder "General" type here.
    expect(mockDb.ticketType.create).not.toHaveBeenCalled();
  });

  it("uses the organizer's fallback for rows with a blank cell", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(PHYSICIAN);

    const res = await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,`, "tt-phys"), params);

    expect(res.status).toBe(200);
    const data = createdRegistration();
    expect(data.ticketTypeId).toBe("tt-phys");
    expect(mockDb.ticketType.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "tt-phys" }) })
    );
    // The attendee's free-text category mirrors the resolved type.
    expect(mockDb.attendee.create.mock.calls[0][0].data.registrationType).toBe("Physician");
  });

  it("lets the row's own cell win over the fallback", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(PHYSICIAN);

    const res = await POST(
      csvRequest(`${HEADER}\nJohn,Doe,john@example.com,Student`, "tt-phys"),
      params
    );

    expect(res.status).toBe(200);
    // "Student" isn't on the event yet, so it's created and used — not the fallback.
    expect(mockDb.ticketType.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Student" }) })
    );
  });

  it("400s before touching any row when the picked fallback is a faculty type", async () => {
    mockDb.ticketType.findFirst.mockResolvedValue(HIDDEN_FACULTY);

    const res = await POST(
      csvRequest(`${HEADER}\nJohn,Doe,john@example.com,`, "tt-faculty"),
      params
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "TICKET_TYPE_IS_FACULTY" });
    expect(mockDb.registration.create).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "events/import-registrations:invalid-default-ticket-type" })
    );
  });

  it("rejects a row whose cell names the hidden faculty type instead of miscategorising it", async () => {
    const res = await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,Faculty`), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.errors[0]).toContain("reserved for speaker faculty");
    expect(mockDb.registration.create).not.toHaveBeenCalled();
    // And it must NOT quietly mint a second type with the same name.
    expect(mockDb.ticketType.create).not.toHaveBeenCalled();
  });

  it("matches a non-faculty type named Faculty by name (an ordinary delegate type)", async () => {
    const delegateFaculty = { ...HIDDEN_FACULTY, id: "tt-fac-delegate", isFaculty: false };
    mockDb.ticketType.findMany.mockResolvedValue([delegateFaculty, PHYSICIAN]);

    const res = await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,Faculty`), params);

    expect(res.status).toBe(200);
    expect(createdRegistration().ticketTypeId).toBe("tt-fac-delegate");
  });

  it("reports how many rows imported with no registration type", async () => {
    const res = await POST(
      csvRequest(`${HEADER}\nJohn,Doe,john@example.com,\nJane,Roe,jane@example.com,Physician`),
      params
    );

    expect(await res.json()).toMatchObject({ created: 2, uncategorised: 1 });
  });

  it("keeps an uncategorised row COMPLIMENTARY + CONFIRMED (nothing is owed)", async () => {
    await POST(csvRequest(`${HEADER}\nJohn,Doe,john@example.com,`), params);

    const data = createdRegistration();
    expect(data.paymentStatus).toBe("COMPLIMENTARY");
    expect(data.status).toBe("CONFIRMED");
  });
});
