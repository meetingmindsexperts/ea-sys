/**
 * POST /api/events/[eventId]/sessions/bulk-delete (Sep 2, 2026).
 *
 * Pins that the single DELETE's guards hold per row under bulk: the webinar
 * anchor is refused and REPORTED, each Zoom meeting is torn down first through
 * the never-throws helper, everything is event-bound, and the local delete is
 * one atomic deleteMany.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockDeleteRemote, mockRefreshStats } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockDeleteRemote: vi.fn(),
  mockRefreshStats: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: mockDeleteRemote }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (u: { organizationId?: string | null }, id: string) => ({
    id,
    organizationId: u.organizationId,
  }),
}));
// denyReviewer is REAL (pure): the 403 below is the actual guard.

import { POST, MAX_BULK_DELETE } from "@/app/api/events/[eventId]/sessions/bulk-delete/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const admin = { user: { id: "u1", role: "ADMIN", organizationId: "org1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockDeleteRemote.mockResolvedValue(true);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: {} });
  mockDb.eventSession.deleteMany.mockImplementation(async ({ where }) => ({
    count: where.id.in.length,
  }));
});

describe("guards", () => {
  it("401 unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req({ sessionIds: ["a"] }), params)).status).toBe(401);
  });
  it("403 for a reviewer, before any lookup", async () => {
    mockAuth.mockResolvedValue({ user: { id: "r", role: "REVIEWER", organizationId: null } });
    expect((await POST(req({ sessionIds: ["a"] }), params)).status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });
  it("400 on an empty list and on more than the cap", async () => {
    expect((await POST(req({ sessionIds: [] }), params)).status).toBe(400);
    const tooMany = Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => `s${i}`);
    expect((await POST(req({ sessionIds: tooMany }), params)).status).toBe(400);
    expect(mockDb.eventSession.deleteMany).not.toHaveBeenCalled();
  });
  it("404 when the event is not the caller's", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await POST(req({ sessionIds: ["a"] }), params)).status).toBe(404);
  });
});

describe("deleting", () => {
  it("tears each Zoom meeting down first, deletes the found rows in ONE event-bound deleteMany, and reports unknown ids", async () => {
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "a", name: "Keynote", zoomMeeting: { zoomMeetingId: "999", meetingType: "MEETING" } },
      { id: "b", name: "Break", zoomMeeting: null },
    ]);
    const res = await POST(req({ sessionIds: ["a", "b", "ghost"] }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ deletedCount: 2, deletedIds: ["a", "b"], skipped: [], notFound: ["ghost"] });

    expect(mockDeleteRemote).toHaveBeenCalledTimes(1);
    expect(mockDeleteRemote).toHaveBeenCalledWith(
      expect.objectContaining({ zoomMeetingId: "999", reason: "session-bulk-delete" }),
    );
    // Zoom before the local delete.
    expect(mockDeleteRemote.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.eventSession.deleteMany.mock.invocationCallOrder[0],
    );
    expect(mockDb.eventSession.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockDb.eventSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] }, eventId: "ev1" },
    });
    expect(mockRefreshStats).toHaveBeenCalledWith("ev1");
  });

  it("refuses the webinar anchor and REPORTS it, while still deleting the rest", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      organizationId: "org1",
      settings: { webinar: { sessionId: "anchor" } },
    });
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "anchor", name: "Main webinar", zoomMeeting: { zoomMeetingId: "1", meetingType: "WEBINAR" } },
      { id: "x", name: "Extra", zoomMeeting: null },
    ]);
    const body = await (await POST(req({ sessionIds: ["anchor", "x"] }), params)).json();
    expect(body.deletedCount).toBe(1);
    expect(body.deletedIds).toEqual(["x"]);
    expect(body.skipped).toEqual([{ id: "anchor", name: "Main webinar", code: "WEBINAR_ANCHOR_SESSION" }]);
    // The anchor's Zoom webinar is NOT torn down and its id never reaches the delete.
    expect(mockDeleteRemote).not.toHaveBeenCalled();
    expect(mockDb.eventSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["x"] }, eventId: "ev1" },
    });
  });

  it("a Zoom outage never blocks the local delete", async () => {
    mockDeleteRemote.mockResolvedValue(false);
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "a", name: "Keynote", zoomMeeting: { zoomMeetingId: "999", meetingType: "MEETING" } },
    ]);
    const body = await (await POST(req({ sessionIds: ["a"] }), params)).json();
    expect(body.deletedCount).toBe(1);
  });

  it("dedupes a repeated id so it cannot double-count or double-tear-down", async () => {
    mockDb.eventSession.findMany.mockResolvedValue([
      { id: "a", name: "Keynote", zoomMeeting: { zoomMeetingId: "999", meetingType: "MEETING" } },
    ]);
    const body = await (await POST(req({ sessionIds: ["a", "a", "a"] }), params)).json();
    expect(body.deletedCount).toBe(1);
    expect(mockDeleteRemote).toHaveBeenCalledTimes(1);
    expect(mockDb.eventSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["a"] }, eventId: "ev1" } }),
    );
  });

  it("writes ONE audit row for the batch carrying every outcome", async () => {
    mockDb.eventSession.findMany.mockResolvedValue([{ id: "a", name: "Keynote", zoomMeeting: null }]);
    await POST(req({ sessionIds: ["a", "ghost"] }), params);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toMatchObject({ bulk: true, deletedIds: ["a"], skipped: [], notFound: ["ghost"] });
  });
});
