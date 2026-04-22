/**
 * Unit tests for src/services/accommodation-service.ts — the first service
 * extracted as part of the Phase 1 services refactor. Pattern established
 * here (mock db + external helpers, assert on result shape + side effects)
 * is reused for every subsequent service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    roomType: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    accommodation: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    // $transaction invokes its callback with a tx proxy pointing at the
    // mock accommodation/roomType. Lets the tx body run under vi.fn control.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      return cb({
        roomType: {
          findUnique: (...a: unknown[]) =>
            (mockDb.roomType.findUnique as (...a: unknown[]) => unknown)(...a),
          update: (...a: unknown[]) =>
            (mockDb.roomType.update as (...a: unknown[]) => unknown)(...a),
        },
        accommodation: {
          create: (...a: unknown[]) =>
            (mockDb.accommodation.create as (...a: unknown[]) => unknown)(...a),
        },
      });
    }),
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { createAccommodation } from "@/services/accommodation-service";

const BASE_INPUT = {
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  registrationId: "reg-1",
  roomTypeId: "rt-1",
  checkIn: new Date("2026-06-01"),
  checkOut: new Date("2026-06-03"),
  source: "rest" as const,
};

const ROOM_TYPE_FIXTURE = {
  id: "rt-1",
  capacity: 2,
  pricePerNight: 200,
  currency: "USD",
  bookedRooms: 5,
  totalRooms: 10,
};

const CREATED_FIXTURE = {
  id: "acc-1",
  status: "PENDING",
  checkIn: BASE_INPUT.checkIn,
  checkOut: BASE_INPUT.checkOut,
  guestCount: 1,
  totalPrice: 400,
  currency: "USD",
  specialRequests: null,
  roomType: { id: "rt-1", name: "Deluxe", hotel: { id: "h-1", name: "Grand Hotel" } },
  registration: null,
  speaker: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg-1", accommodation: null });
  mockDb.speaker.findFirst.mockResolvedValue(null);
  mockDb.roomType.findFirst.mockResolvedValue(ROOM_TYPE_FIXTURE);
  mockDb.roomType.findUnique.mockResolvedValue({ bookedRooms: 5, totalRooms: 10 });
  mockDb.accommodation.create.mockResolvedValue(CREATED_FIXTURE);
  mockDb.roomType.update.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("createAccommodation — happy path", () => {
  it("returns ok=true with the created row + nights computed", async () => {
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accommodation.id).toBe("acc-1");
      expect(result.nights).toBe(2);
    }
  });

  it("computes totalPrice from nights × pricePerNight", async () => {
    await createAccommodation(BASE_INPUT);
    const call = mockDb.accommodation.create.mock.calls[0][0];
    expect(call.data.totalPrice).toBe(400); // 200 * 2 nights
    expect(call.data.currency).toBe("USD");
  });

  it("atomically increments bookedRooms inside the transaction", async () => {
    await createAccommodation(BASE_INPUT);
    expect(mockDb.roomType.update).toHaveBeenCalledWith({
      where: { id: "rt-1" },
      data: { bookedRooms: { increment: 1 } },
    });
  });

  it("writes an audit log carrying the source field (REST)", async () => {
    await createAccommodation({ ...BASE_INPUT, source: "rest", requestIp: "1.2.3.4" });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREATE",
        entityType: "Accommodation",
        changes: expect.objectContaining({ source: "rest", ip: "1.2.3.4", nights: 2 }),
      }),
    });
  });

  it("writes an audit log carrying the source field (MCP, no IP)", async () => {
    await createAccommodation({ ...BASE_INPUT, source: "mcp" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.source).toBe("mcp");
    expect(auditCall.data.changes.ip).toBeUndefined();
  });

  it("assigns by speaker when speakerId provided (no registrationId)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk-1", accommodation: null });
    const result = await createAccommodation({
      ...BASE_INPUT,
      registrationId: undefined,
      speakerId: "spk-1",
    });
    expect(result.ok).toBe(true);
    const createCall = mockDb.accommodation.create.mock.calls[0][0];
    expect(createCall.data.speakerId).toBe("spk-1");
    expect(createCall.data.registrationId).toBeUndefined();
  });

  it("clips specialRequests to 1000 chars", async () => {
    await createAccommodation({
      ...BASE_INPUT,
      specialRequests: "x".repeat(2000),
    });
    const createCall = mockDb.accommodation.create.mock.calls[0][0];
    expect(createCall.data.specialRequests).toHaveLength(1000);
  });

  it("coerces guestCount to >= 1 (e.g. 0 becomes 1)", async () => {
    await createAccommodation({ ...BASE_INPUT, guestCount: 0 });
    const createCall = mockDb.accommodation.create.mock.calls[0][0];
    expect(createCall.data.guestCount).toBe(1);
  });
});

describe("createAccommodation — domain errors", () => {
  it("MISSING_ASSIGNEE when neither registrationId nor speakerId is provided", async () => {
    const result = await createAccommodation({
      ...BASE_INPUT,
      registrationId: undefined,
      speakerId: undefined,
    });
    expect(result).toEqual({
      ok: false,
      code: "MISSING_ASSIGNEE",
      message: expect.any(String),
    });
    expect(mockDb.accommodation.create).not.toHaveBeenCalled();
  });

  it("INVALID_DATES when checkOut <= checkIn", async () => {
    const result = await createAccommodation({
      ...BASE_INPUT,
      checkIn: new Date("2026-06-03"),
      checkOut: new Date("2026-06-01"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_DATES");
  });

  it("EVENT_NOT_FOUND when event lookup returns null (cross-org access)", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("EVENT_NOT_FOUND");
  });

  it("REGISTRATION_NOT_FOUND when registrationId doesn't belong to the event", async () => {
    mockDb.registration.findFirst.mockResolvedValue(null);
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REGISTRATION_NOT_FOUND");
  });

  it("SPEAKER_NOT_FOUND when speakerId doesn't belong to the event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    const result = await createAccommodation({
      ...BASE_INPUT,
      registrationId: undefined,
      speakerId: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SPEAKER_NOT_FOUND");
  });

  it("REGISTRATION_HAS_ACCOMMODATION with existing id in meta", async () => {
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg-1",
      accommodation: { id: "acc-existing" },
    });
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REGISTRATION_HAS_ACCOMMODATION");
      expect(result.meta).toEqual({ existingAccommodationId: "acc-existing" });
    }
  });

  it("SPEAKER_HAS_ACCOMMODATION with existing id in meta", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "spk-1",
      accommodation: { id: "acc-existing" },
    });
    const result = await createAccommodation({
      ...BASE_INPUT,
      registrationId: undefined,
      speakerId: "spk-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SPEAKER_HAS_ACCOMMODATION");
      expect(result.meta).toEqual({ existingAccommodationId: "acc-existing" });
    }
  });

  it("ROOM_NOT_FOUND when roomType lookup returns null (inactive, wrong event, or missing)", async () => {
    mockDb.roomType.findFirst.mockResolvedValue(null);
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOM_NOT_FOUND");
  });

  it("GUEST_COUNT_EXCEEDS_CAPACITY when guestCount > roomType.capacity", async () => {
    mockDb.roomType.findFirst.mockResolvedValue({ ...ROOM_TYPE_FIXTURE, capacity: 2 });
    const result = await createAccommodation({ ...BASE_INPUT, guestCount: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("GUEST_COUNT_EXCEEDS_CAPACITY");
      expect(result.meta).toEqual({ capacity: 2 });
    }
  });

  it("NO_ROOMS_AVAILABLE when the in-tx re-check finds the room full", async () => {
    // Pre-check passes (bookedRooms=5 < totalRooms=10) but by the time the tx
    // runs, another booking filled the room. The in-tx findUnique reflects
    // that, and the service maps the sentinel throw to the error code.
    mockDb.roomType.findUnique.mockResolvedValue({ bookedRooms: 10, totalRooms: 10 });
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ROOMS_AVAILABLE");
    expect(mockDb.accommodation.create).not.toHaveBeenCalled();
    expect(mockDb.roomType.update).not.toHaveBeenCalled();
  });

  it("UNKNOWN for unexpected transaction failures (e.g. DB down)", async () => {
    mockDb.$transaction.mockRejectedValueOnce(new Error("Connection refused"));
    const result = await createAccommodation(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toContain("Connection refused");
    }
  });
});

describe("createAccommodation — audit log is non-blocking", () => {
  it("still returns ok=true when auditLog.create rejects (fire-and-forget)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("audit DB down"));
    const result = await createAccommodation(BASE_INPUT);
    // We can't await the fire-and-forget catch inside the service, so the
    // assertion is just that the happy path still returns ok=true without
    // the audit-log failure propagating.
    expect(result.ok).toBe(true);
  });
});
