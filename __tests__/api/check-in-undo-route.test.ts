/**
 * Undo check-in route (review H2). Before this endpoint existed there was no
 * way to reverse a mistaken check-in — a status flip left checkedInAt set and
 * locked the attendee out of the scanner forever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockUndo, mockExecute, mockGate } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockUndo: vi.fn(),
  mockExecute: vi.fn(),
  mockGate: vi.fn(),
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
  checkInGate: (...a: unknown[]) => mockGate(...a),
  executeCheckIn: (a: unknown) => mockExecute(a),
  undoCheckIn: (a: unknown) => mockUndo(a),
}));

import { DELETE, PUT } from "@/app/api/events/[eventId]/registrations/[registrationId]/check-in/route";

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

// ─────────────────────────────────────────────────────────────────────────────
// PUT (scan check-in) — serial-suffixed barcode lookup (July 29, 2026)
// ─────────────────────────────────────────────────────────────────────────────

const putReq = (qrCode: string) =>
  new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ qrCode }), headers: { "content-type": "application/json" } });

describe("PUT (scan check-in) — accepts bare AND serial-suffixed codes", () => {
  beforeEach(() => {
    // A matched registration that passes the gate straight through.
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg1",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      checkedInAt: null,
      ticketType: { name: "Standard", price: 100 },
      pricingTier: null,
      attendee: { firstName: "A", lastName: "B" },
    });
  });

  it("a serial-suffixed scan ({qrCode}-{serial}) also tries the bare stored code", async () => {
    const res = await PUT(putReq("1753791234567123456-007"), params);
    expect(res.status).toBe(200);
    const where = mockDb.registration.findFirst.mock.calls[0][0].where as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0]).toEqual({ qrCode: { in: ["1753791234567123456-007", "1753791234567123456"] } });
    // DTCM barcodes (external, arbitrary) always match the scan as-is.
    expect(where.OR[1]).toEqual({ dtcmBarcode: "1753791234567123456-007" });
  });

  it("a legacy bare scan matches exactly (single candidate)", async () => {
    const res = await PUT(putReq("1753791234567123456"), params);
    expect(res.status).toBe(200);
    const where = mockDb.registration.findFirst.mock.calls[0][0].where as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0]).toEqual({ qrCode: { in: ["1753791234567123456"] } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT — self-service kiosk tagging (Aug 3, 2026): a kiosk scan sends
// `kiosk: true` and the audit trail must distinguish it from a staff scan.
// ─────────────────────────────────────────────────────────────────────────────

const kioskReq = (body: Record<string, unknown>) =>
  new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("PUT (scan check-in) — kiosk audit tagging", () => {
  beforeEach(() => {
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg1",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      checkedInAt: null,
      ticketType: { name: "Standard", price: 100 },
      pricingTier: null,
      attendee: { firstName: "A", lastName: "B" },
    });
  });

  it("kiosk: true lands in the audit extras", async () => {
    const res = await PUT(kioskReq({ qrCode: "123", kiosk: true }), params);
    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "rest-qr",
        auditExtras: expect.objectContaining({ kiosk: true }),
      }),
    );
  });

  it("a staff scan (no flag) carries NO kiosk key", async () => {
    const res = await PUT(kioskReq({ qrCode: "123" }), params);
    expect(res.status).toBe(200);
    const args = mockExecute.mock.calls[0][0] as { auditExtras: Record<string, unknown> };
    expect("kiosk" in args.auditExtras).toBe(false);
  });

  it("a non-boolean kiosk value is not trusted", async () => {
    const res = await PUT(kioskReq({ qrCode: "123", kiosk: "yes" }), params);
    expect(res.status).toBe(200);
    const args = mockExecute.mock.calls[0][0] as { auditExtras: Record<string, unknown> };
    expect("kiosk" in args.auditExtras).toBe(false);
  });

  // The kiosk's REPRINT path depends on this exact 400 body shape (code +
  // the full registration + checkedInAt) — pin it so a route refactor can't
  // silently regress the kiosk into "Code not recognised" for every
  // already-checked-in attendee (review M4).
  it("ALREADY_CHECKED_IN 400 carries code + registration + checkedInAt", async () => {
    const checkedInAt = new Date("2026-08-03T09:00:00.000Z");
    mockGate.mockReturnValue({ code: "ALREADY_CHECKED_IN", message: "Already checked in", checkedInAt });
    const res = await PUT(kioskReq({ qrCode: "123", kiosk: true }), params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_CHECKED_IN");
    expect(body.checkedInAt).toEqual(checkedInAt);
    expect(body.registration).toMatchObject({ id: "reg1", attendee: { firstName: "A", lastName: "B" } });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
