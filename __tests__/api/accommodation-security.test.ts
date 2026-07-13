/**
 * Accommodation/hotels review — Phase 1 (security).
 *
 * H1: the room-type routes resolved the room by `{ id: roomId, hotelId }` with
 *     the hotelId taken straight from the URL and NEVER bound to the (org-verified)
 *     event — a broken authorization chain. These tests pin the full bind:
 *     room → hotel → event.
 *
 * H2: the booking payloads embedded the FULL Registration row via `include`,
 *     leaking `qrCode` + `dtcmBarcode` (door credentials) and every financial
 *     scalar to roles that must not see them (notably MEMBER, deliberately
 *     excluded from BARCODE_ROLES). These pin the allow-list `select`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    roomType: { findFirst: vi.fn() },
    accommodation: { findFirst: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: () => {} },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT" || role === "MEMBER") {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));

import { GET as roomGet } from "@/app/api/events/[eventId]/hotels/[hotelId]/rooms/[roomId]/route";
import { GET as accGet } from "@/app/api/events/[eventId]/accommodations/[accommodationId]/route";

const req = {} as Request;
const roomParams = Promise.resolve({ eventId: "ev_1", hotelId: "hot_1", roomId: "rt_1" });
const accParams = Promise.resolve({ eventId: "ev_1", accommodationId: "acc_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role: "ADMIN" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev_1" });
  mockDb.roomType.findFirst.mockResolvedValue({ id: "rt_1", name: "Double", accommodations: [], _count: { accommodations: 0 } });
  mockDb.accommodation.findFirst.mockResolvedValue({ id: "acc_1", status: "CONFIRMED" });
});

describe("H1 — room-type routes bind the full room → hotel → event chain", () => {
  it("GET resolves the room through the hotel bound to the event (not a bare hotelId)", async () => {
    await roomGet(req, { params: roomParams });

    expect(mockDb.roomType.findFirst).toHaveBeenCalledTimes(1);
    const where = mockDb.roomType.findFirst.mock.calls[0][0].where;
    // The whole chain — a foreign hotelId can no longer match, because the
    // hotel itself must belong to the org-verified event.
    expect(where).toEqual({ id: "rt_1", hotel: { id: "hot_1", eventId: "ev_1" } });
  });

  it("404s (and logs) when the event is not in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await roomGet(req, { params: roomParams });
    expect(res.status).toBe(404);
    // The room is never even looked up once the event check fails.
    expect(mockDb.roomType.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the room exists but its hotel belongs to another event", async () => {
    // The bound `where` simply won't match → Prisma returns null.
    mockDb.roomType.findFirst.mockResolvedValue(null);
    const res = await roomGet(req, { params: roomParams });
    expect(res.status).toBe(404);
  });
});

describe("H2 — booking payloads never fetch door credentials or raw financials", () => {
  it("the room GET selects only safe booking fields (no qrCode / dtcmBarcode)", async () => {
    await roomGet(req, { params: roomParams });

    const include = mockDb.roomType.findFirst.mock.calls[0][0].include;
    const regSelect = include.accommodations.select.registration.select;

    // An allow-list, not `include: true` — so a sensitive column added to
    // Registration later cannot leak through this endpoint by default.
    expect(regSelect).toBeDefined();
    expect(regSelect.qrCode).toBeUndefined();
    expect(regSelect.dtcmBarcode).toBeUndefined();
    expect(regSelect.attendee.select).toEqual({ firstName: true, lastName: true, email: true });
  });

  it("the accommodation detail GET selects only safe registration fields", async () => {
    await accGet(req, { params: accParams });

    const include = mockDb.accommodation.findFirst.mock.calls[0][0].include;
    const regSelect = include.registration.select;

    expect(regSelect.qrCode).toBeUndefined();
    expect(regSelect.dtcmBarcode).toBeUndefined();
    // ...but the fields the booking UI actually renders are still there.
    expect(regSelect.attendee.select.firstName).toBe(true);
    expect(regSelect.attendee.select.email).toBe(true);
  });
});
