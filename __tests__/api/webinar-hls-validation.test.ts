/**
 * Save-time HLS validation (webinar waiting-room review #5 follow-up):
 * "Custom stream" (hls) viewing mode requires the anchor session's live
 * stream to actually be configured. Enforced at BOTH doors:
 *  - PUT /api/events/[eventId]/webinar     — switching the mode to hls
 *  - POST /api/events/[eventId]/webinar/room — opening the room in hls mode
 * so attendees can never be admitted into a permanent "getting the stream
 * ready" screen at go-live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger, mockUpdateEventSettings } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockUpdateEventSettings: vi.fn(async () => ({})),
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn(), updateMany: vi.fn() },
    zoomMeeting: { findUnique: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: () => ({ orgId: "org1" }),
}));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: vi.fn() }));
vi.mock("@/lib/zoom", () => ({ enableWebinarQA: vi.fn() }));

import { PUT as webinarPut } from "@/app/api/events/[eventId]/webinar/route";
import { POST as roomPost } from "@/app/api/events/[eventId]/webinar/room/route";

function callPut(body: unknown) {
  const req = { json: async () => body, headers: new Headers() } as unknown as Request;
  return webinarPut(req, { params: Promise.resolve({ eventId: "ev1" }) });
}
function callRoom(body: unknown) {
  const req = { json: async () => body, headers: new Headers() } as unknown as Request;
  return roomPost(req, { params: Promise.resolve({ eventId: "ev1" }) });
}

const STREAM_OK = { liveStreamEnabled: true, streamKey: "sk-1" };
const STREAM_OFF = { liveStreamEnabled: false, streamKey: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateEventSettings.mockResolvedValue({});
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    settings: { webinar: { sessionId: "anchor1", viewingMode: "hls" } },
  });
  mockDb.eventSession.updateMany.mockResolvedValue({ count: 1 });
  mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OK);
});

describe("PUT /webinar — hls mode requires a configured live stream", () => {
  it("rejects switching to hls when the live stream is not configured", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("HLS_STREAM_NOT_CONFIGURED");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1" }),
      "webinar:hls-mode-without-stream-rejected",
    );
  });

  it("rejects hls when there is no Zoom meeting on the anchor at all", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(null);
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(400);
  });

  it("accepts hls when the stream is configured", async () => {
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(200);
    expect(mockUpdateEventSettings).toHaveBeenCalled();
  });

  it("a lobby-message-only save on an already-hls event is NOT retro-blocked", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callPut({ lobbyMessage: "starting soon" });
    expect(res.status).toBe(200);
    // The gate only fires when the REQUEST sets hls.
    expect(mockDb.zoomMeeting.findUnique).not.toHaveBeenCalled();
  });

  it("switching to zoom mode never checks the stream", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callPut({ viewingMode: "zoom" });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /webinar/room — opening in hls mode is the final gate", () => {
  it("refuses to open the room when hls mode has no configured stream", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callRoom({ open: true });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("HLS_STREAM_NOT_CONFIGURED");
    expect(mockDb.eventSession.updateMany).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1" }),
      "webinar:room-open-hls-not-configured",
    );
  });

  it("opens the room when the hls stream is configured", async () => {
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "LIVE" } }),
    );
  });

  it("CLOSING the room is always allowed, even misconfigured", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callRoom({ open: false });
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETED" } }),
    );
  });

  it("zoom viewing mode opens without a stream check", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      settings: { webinar: { sessionId: "anchor1", viewingMode: "zoom" } },
    });
    mockDb.zoomMeeting.findUnique.mockResolvedValue(STREAM_OFF);
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findUnique).not.toHaveBeenCalled();
  });
});
