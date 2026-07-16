import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb, mockUpdateEventSettings } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
    // Financial-records guard on event DELETE — default to "none" so existing
    // delete tests proceed; the guard's own behavior is covered in
    // event-delete-financial-guard.test.ts.
    invoice: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    // M9 date-narrowing guard on PUT — default to "no sessions" so tests
    // that change dates proceed unless they set this up explicitly.
    eventSession: { findMany: vi.fn().mockResolvedValue([]) },
  },
  // Settings now merge through the atomic helper (its own test covers the merge);
  // here we just assert the route hands it the right patch.
  mockUpdateEventSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));

vi.mock("@/lib/event-settings", () => ({
  updateEventSettings: (...args: unknown[]) => mockUpdateEventSettings(...args),
  updateOrganizationSettings: vi.fn(),
}));

vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(
    (user: { role: string; organizationId?: string | null }, eventId?: string) => ({
      ...(eventId && { id: eventId }),
      organizationId: user.organizationId,
    })
  ),
}));

vi.mock("@/lib/security", () => ({
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

// Import route AFTER mocks
import { GET, PUT, DELETE } from "@/app/api/events/[eventId]/route";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeParams(eventId: string) {
  return { params: Promise.resolve({ eventId }) };
}

function makeGetRequest() {
  return new Request("http://localhost/api/events/evt-1", { method: "GET" });
}

function makePutRequest(body: unknown) {
  return new Request("http://localhost/api/events/evt-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest() {
  return new Request("http://localhost/api/events/evt-1?confirm=true", { method: "DELETE" });
}

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const reviewerSession = { user: { id: "rev-1", role: "REVIEWER", organizationId: null } };
const submitterSession = { user: { id: "sub-1", role: "SUBMITTER", organizationId: null } };

const sampleEvent = {
  id: "evt-1",
  organizationId: "org-1",
  name: "Test Event",
  slug: "test-event",
  description: "A test event",
  status: "DRAFT",
  startDate: new Date("2026-06-01"),
  endDate: new Date("2026-06-03"),
  settings: {},
  _count: { registrations: 10, speakers: 5, eventSessions: 3, tracks: 2 },
};

// ── GET Tests ────────────────────────────────────────────────────────────────

describe("GET /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns event data for authenticated user", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(sampleEvent);
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Event");
    expect(body._count.registrations).toBe(10);
  });

  it("returns 500 on database error", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockRejectedValue(new Error("DB error"));
    const res = await GET(makeGetRequest(), makeParams("evt-1"));
    expect(res.status).toBe(500);
  });
});

// ── PUT Tests ────────────────────────────────────────────────────────────────

describe("PUT /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 for SUBMITTER role", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await PUT(makePutRequest({ name: "Updated" }), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid input", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    const res = await PUT(makePutRequest({ name: "x" }), makeParams("evt-1")); // too short
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error", "Invalid input");
  });

  it("updates event successfully", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue({ ...sampleEvent, name: "Updated Event" });
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(makePutRequest({ name: "Updated Event" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Updated Event");
  });

  // M9 (program/agenda review): narrowing the event's dates used to silently
  // orphan out-of-range sessions — they kept rendering on the public agenda
  // while any edit to them was rejected. The PUT now blocks with a clear
  // error naming the sessions.
  it("blocks a date change that would orphan out-of-range sessions", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    // A day-3 session (June 3, Dubai) that the shortened window drops.
    mockDb.eventSession.findMany.mockResolvedValue([
      {
        id: "sess-3",
        name: "Day 3 Closing",
        startTime: new Date("2026-06-03T05:00:00Z"),
        endTime: new Date("2026-06-03T06:00:00Z"),
      },
    ]);

    const res = await PUT(
      makePutRequest({
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-02T00:00:00.000Z", // 3 days → 2
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("SESSIONS_OUTSIDE_NEW_DATES");
    expect(body.error).toContain("Day 3 Closing");
    expect(body.sessions).toHaveLength(1);
    expect(mockDb.event.update).not.toHaveBeenCalled();
  });

  it("allows a date change when every session still fits the new window", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: {},
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-03T00:00:00Z"),
      timezone: "Asia/Dubai",
    });
    mockDb.eventSession.findMany.mockResolvedValue([
      {
        id: "sess-1",
        name: "Day 1 Opening",
        startTime: new Date("2026-06-01T05:00:00Z"),
        endTime: new Date("2026-06-01T06:00:00Z"),
      },
    ]);
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(
      makePutRequest({
        startDate: "2026-06-01T00:00:00.000Z",
        endDate: "2026-06-02T00:00:00.000Z",
      }),
      makeParams("evt-1"),
    );
    expect(res.status).toBe(200);
    expect(mockDb.event.update).toHaveBeenCalled();
  });

  it("does not run the session check when dates are untouched", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await PUT(makePutRequest({ name: "Renamed Event" }), makeParams("evt-1"));
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate slug", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst
      .mockResolvedValueOnce({ id: "evt-1", slug: "old-slug", settings: {} }) // existing event
      .mockResolvedValueOnce({ id: "evt-2" }); // slug already taken

    const res = await PUT(makePutRequest({ slug: "taken-slug" }), makeParams("evt-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("slug already exists");
  });

  it("merges settings with existing settings", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({
      id: "evt-1",
      slug: "test",
      settings: { registrationOpen: true, maxAttendees: 100 },
    });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    await PUT(
      makePutRequest({ settings: { registrationOpen: false, waitlistEnabled: true } }),
      makeParams("evt-1")
    );

    // Settings now merge atomically via updateEventSettings (row-locked) instead
    // of an inline spread on db.event.update. The route hands it the incoming
    // patch; the helper merges it over the locked-current settings (covered in
    // event-settings.test.ts). The general PUT must NOT carry the settings on
    // the scalar db.event.update anymore.
    expect(mockUpdateEventSettings).toHaveBeenCalledWith("evt-1", {
      registrationOpen: false,
      waitlistEnabled: true,
    });
    const scalarUpdate = mockDb.event.update.mock.calls[0]?.[0];
    if (scalarUpdate) {
      expect(scalarUpdate.data).not.toHaveProperty("settings");
    }
  });

  it("creates audit log on successful update", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", slug: "test", settings: {} });
    mockDb.event.update.mockResolvedValue(sampleEvent);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    await PUT(makePutRequest({ name: "New Name" }), makeParams("evt-1"));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "evt-1",
          action: "UPDATE",
          entityType: "Event",
        }),
      })
    );
  });
});

// ── DELETE Tests ──────────────────────────────────────────────────────────────

describe("DELETE /api/events/[eventId]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for REVIEWER role", async () => {
    mockAuth.mockResolvedValue(reviewerSession);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 403 for SUBMITTER role", async () => {
    mockAuth.mockResolvedValue(submitterSession);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(403);
  });

  it("returns 404 when event not found", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(404);
  });

  it("deletes event successfully", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", name: "Test Event" });
    mockDb.event.delete.mockResolvedValue({});
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });

    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockDb.event.delete).toHaveBeenCalledWith({ where: { id: "evt-1" } });
  });

  it("returns 500 on database error", async () => {
    mockAuth.mockResolvedValue(adminSession);
    mockDb.event.findFirst.mockResolvedValue({ id: "evt-1", name: "Test" });
    mockDb.event.delete.mockRejectedValue(new Error("FK constraint"));

    const res = await DELETE(makeDeleteRequest(), makeParams("evt-1"));
    expect(res.status).toBe(500);
  });
});
