/**
 * WEBINAR events run in ONE Zoom room (owner decision, Aug 4 2026): the POST
 * that creates a session's Zoom meeting must refuse any NON-anchor session on
 * a WEBINAR-type event — a second Zoom webinar splits attendees (whose links
 * all point at the anchor) from the producer's broadcast.
 *
 * Pins: the 409 WEBINAR_ANCHOR_ONLY refusal + no Zoom API call; creation on
 * the anchor itself stays allowed (the delete-and-recreate recovery path);
 * conference events are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockApiLogger, mockZoom } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockZoom: {
    isZoomConfigured: vi.fn(),
    createZoomMeeting: vi.fn(),
    createZoomWebinar: vi.fn(),
    createWebinarSeries: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/zoom", () => ({
  isZoomConfigured: (...a: unknown[]) => mockZoom.isZoomConfigured(...a),
  createZoomMeeting: (...a: unknown[]) => mockZoom.createZoomMeeting(...a),
  createZoomWebinar: (...a: unknown[]) => mockZoom.createZoomWebinar(...a),
  createWebinarSeries: (...a: unknown[]) => mockZoom.createWebinarSeries(...a),
  getZoomMeeting: vi.fn(),
  getZoomWebinar: vi.fn(),
  updateZoomMeeting: vi.fn(),
  updateZoomWebinar: vi.fn(),
  enableZoomLiveStreaming: vi.fn(),
  enableWebinarLiveStreaming: vi.fn(),
}));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: vi.fn() }));

import { POST } from "@/app/api/events/[eventId]/sessions/[sessionId]/zoom/route";

const params = (sessionId = "s2") =>
  ({ params: Promise.resolve({ eventId: "ev1", sessionId }) }) as {
    params: Promise<{ eventId: string; sessionId: string }>;
  };

const req = (body: Record<string, unknown> = { meetingType: "WEBINAR" }) =>
  new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) });

const SESSION = {
  id: "s2",
  name: "Second Session",
  startTime: new Date("2026-09-04T10:00:00Z"),
  endTime: new Date("2026-09-04T11:00:00Z"),
  description: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.eventSession.findFirst.mockResolvedValue(SESSION);
  mockDb.zoomMeeting.findUnique.mockResolvedValue(null);
  mockDb.auditLog.create.mockResolvedValue({});
  mockZoom.isZoomConfigured.mockResolvedValue(true);
});

function webinarEvent(anchorSessionId: string | null) {
  return {
    id: "ev1",
    organizationId: "org1",
    timezone: "Asia/Dubai",
    slug: "webinar-1",
    eventType: "WEBINAR",
    settings: anchorSessionId ? { webinar: { sessionId: anchorSessionId } } : {},
  };
}

describe("POST sessions/[sessionId]/zoom — WEBINAR anchor-only guard", () => {
  it("refuses a Zoom create on a NON-anchor session of a WEBINAR event (409, no Zoom call)", async () => {
    mockDb.event.findFirst.mockResolvedValue(webinarEvent("anchor1"));
    const res = await POST(req(), params("s2"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("WEBINAR_ANCHOR_ONLY");
    expect(body.anchorSessionId).toBe("anchor1");
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
    expect(mockZoom.createZoomMeeting).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1", sessionId: "s2", anchorSessionId: "anchor1" }),
      "zoom:webinar-non-anchor-create-refused",
    );
  });

  it("blocks plain MEETINGs on non-anchor sessions too (any second room splits the event)", async () => {
    mockDb.event.findFirst.mockResolvedValue(webinarEvent("anchor1"));
    const res = await POST(req({ meetingType: "MEETING" }), params("s2"));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("WEBINAR_ANCHOR_ONLY");
  });

  it("allows creation ON the anchor session (the delete-and-recreate recovery path)", async () => {
    mockDb.event.findFirst.mockResolvedValue(webinarEvent("s2"));
    mockZoom.createZoomWebinar.mockResolvedValue({
      id: 123,
      join_url: "j",
      start_url: "s",
      password: "p",
    });
    mockDb.zoomMeeting.create.mockResolvedValue({
      id: "zm1",
      zoomMeetingId: "123",
      meetingType: "WEBINAR",
      joinUrl: "j",
      startUrl: "s",
      passcode: "p",
    });
    const res = await POST(req(), params("s2"));
    expect(res.status).not.toBe(409);
    expect(mockZoom.createZoomWebinar).toHaveBeenCalled();
  });

  it("a WEBINAR event with NO anchor configured is not blocked (nothing to split from)", async () => {
    mockDb.event.findFirst.mockResolvedValue(webinarEvent(null));
    mockZoom.createZoomWebinar.mockResolvedValue({
      id: 124,
      join_url: "j",
      start_url: "s",
      password: "p",
    });
    mockDb.zoomMeeting.create.mockResolvedValue({
      id: "zm2",
      zoomMeetingId: "124",
      meetingType: "WEBINAR",
      joinUrl: "j",
      startUrl: "s",
      passcode: "p",
    });
    const res = await POST(req(), params("s2"));
    expect(res.status).not.toBe(409);
  });

  it("CONFERENCE events are untouched by the guard", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      ...webinarEvent("anchor1"),
      eventType: "CONFERENCE",
    });
    mockZoom.createZoomMeeting.mockResolvedValue({
      id: 125,
      join_url: "j",
      start_url: "s",
      password: "p",
    });
    mockDb.zoomMeeting.create.mockResolvedValue({
      id: "zm3",
      zoomMeetingId: "125",
      meetingType: "MEETING",
      joinUrl: "j",
      startUrl: "s",
      passcode: "p",
    });
    const res = await POST(req({ meetingType: "MEETING" }), params("s2"));
    expect(res.status).not.toBe(409);
    expect(mockZoom.createZoomMeeting).toHaveBeenCalled();
  });
});
