import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockAuth, mockDb } = vi.hoisted(() => ({
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
  },
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
  return new Request("http://localhost/api/events/evt-1", { method: "DELETE" });
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

    const updateCall = mockDb.event.update.mock.calls[0][0];
    expect(updateCall.data.settings).toEqual({
      registrationOpen: false,
      maxAttendees: 100,
      waitlistEnabled: true,
    });
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
