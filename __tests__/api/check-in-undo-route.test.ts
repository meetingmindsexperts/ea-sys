/**
 * Undo check-in route (review H2). Before this endpoint existed there was no
 * way to reverse a mistaken check-in — a status flip left checkedInAt set and
 * locked the attendee out of the scanner forever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockUndo } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockUndo: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null, REGISTRATION_DESK_ALLOW: {} }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: (_u: unknown, id: string) => ({ id }) }));
vi.mock("@/lib/check-in", () => ({
  checkInGate: vi.fn(),
  executeCheckIn: vi.fn(),
  undoCheckIn: (a: unknown) => mockUndo(a),
}));

import { DELETE } from "@/app/api/events/[eventId]/registrations/[registrationId]/check-in/route";

const params = { params: Promise.resolve({ eventId: "ev1", registrationId: "reg1" }) };
const req = () => new Request("http://localhost/x", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ONSITE", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg1", attendee: { firstName: "A", lastName: "B" } });
});

describe("DELETE (undo check-in)", () => {
  it("undoes a checked-in registration and returns the reverted row", async () => {
    mockUndo.mockResolvedValue({ ok: true, registration: { id: "reg1", status: "CONFIRMED", checkedInAt: null } });
    const res = await DELETE(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("CONFIRMED");
    expect(body.checkedInAt).toBeNull();
    expect(mockUndo).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", registrationId: "reg1", source: "rest" }));
  });

  it("returns 409 NOT_CHECKED_IN when the registration isn't checked in", async () => {
    mockUndo.mockResolvedValue({ ok: false, code: "NOT_CHECKED_IN", message: "This registration is not checked in." });
    const res = await DELETE(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_CHECKED_IN");
  });

  it("404s (logged) when the ONSITE user isn't assigned to the event", async () => {
    mockDb.event.findFirst.mockResolvedValue(null); // buildEventAccessWhere returned nothing
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
    expect(mockUndo).not.toHaveBeenCalled();
  });

  it("404s when the registration isn't in this event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await DELETE(req(), params);
    expect(res.status).toBe(404);
    expect(mockUndo).not.toHaveBeenCalled();
  });
});
