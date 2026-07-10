/**
 * Zoom ↔ session integrity (program/agenda review H2 + H3).
 *
 * H2: the create route's "does this session already have a meeting?" check is
 *     check-then-act. Two concurrent POSTs both call Zoom's create API before
 *     the sessionId @unique constraint rejects the second ROW — leaving a real,
 *     billable, orphaned meeting on Zoom. The loser must tear its own meeting
 *     down and return the 409 the pre-flight check intended.
 * H3: session DELETE never told Zoom (orphaned remote meeting) and had no guard
 *     against deleting the WEBINAR anchor session (dangling
 *     settings.webinar.sessionId → the producer can never open the room again).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockDeleteRemote, mockApiLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockDeleteRemote: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: mockDeleteRemote }));
vi.mock("@/services/session-service", () => ({
  createSession: vi.fn(),
  updateSession: vi.fn(),
}));

import { DELETE as SESSION_DELETE } from "@/app/api/events/[eventId]/sessions/[sessionId]/route";

const params = { params: Promise.resolve({ eventId: "ev1", sessionId: "s1" }) };
const req = () => new Request("http://localhost/x", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDeleteRemote.mockResolvedValue(true);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.eventSession.delete.mockResolvedValue({});
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: {} });
  mockDb.eventSession.findFirst.mockResolvedValue({
    id: "s1",
    name: "Keynote",
    zoomMeeting: { zoomMeetingId: "999", meetingType: "MEETING" },
  });
});

describe("H3 — session DELETE tears down the remote Zoom meeting", () => {
  it("deletes the meeting on Zoom before removing the local session", async () => {
    const res = await SESSION_DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(mockDeleteRemote).toHaveBeenCalledWith({
      organizationId: "org1",
      meetingType: "MEETING",
      zoomMeetingId: "999",
      reason: "session-delete",
    });
    expect(mockDb.eventSession.delete).toHaveBeenCalled();
  });

  it("still deletes the session when Zoom is unreachable (cleanup never blocks)", async () => {
    mockDeleteRemote.mockResolvedValue(false);
    const res = await SESSION_DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.delete).toHaveBeenCalled();
  });

  it("skips the Zoom call for a session with no meeting", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", name: "Talk", zoomMeeting: null });
    const res = await SESSION_DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(mockDeleteRemote).not.toHaveBeenCalled();
  });
});

describe("H3 — the webinar anchor session is undeletable", () => {
  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      organizationId: "org1",
      settings: { webinar: { sessionId: "s1" } }, // s1 IS the anchor
    });
  });

  it("refuses with 409 WEBINAR_ANCHOR_SESSION and touches nothing", async () => {
    const res = await SESSION_DELETE(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WEBINAR_ANCHOR_SESSION");
    expect(mockDb.eventSession.delete).not.toHaveBeenCalled();
    expect(mockDeleteRemote).not.toHaveBeenCalled();
  });

  it("still allows deleting a NON-anchor session on a webinar event", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      organizationId: "org1",
      settings: { webinar: { sessionId: "anchor-other" } },
    });
    const res = await SESSION_DELETE(req(), params);
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.delete).toHaveBeenCalled();
  });
});
