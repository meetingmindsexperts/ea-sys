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
    event: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    eventSession: { findFirst: vi.fn(), updateMany: vi.fn() },
    externalStream: { findFirst: vi.fn(), updateMany: vi.fn() }, zoomMeeting: { findFirst: vi.fn() },
    survey: { findFirst: vi.fn() },
    livePoll: { updateMany: vi.fn() },
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
vi.mock("@/lib/auth-guards", () => ({
  WEBINAR_STAFF_ALLOW: ["WEBINARS"],
  REGISTRATION_DESK_ALLOW: ["ONSITE", "MEMBER", "WEBINARS"], denyReviewer: () => null }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: vi.fn() }));
vi.mock("@/lib/zoom", () => ({ enableWebinarQA: vi.fn() }));
const { mockControlLiveStream } = vi.hoisted(() => ({ mockControlLiveStream: vi.fn() }));
vi.mock("@/lib/webinar/livestream", () => ({ controlWebinarLiveStream: mockControlLiveStream }));
const { mockIsStreamArriving } = vi.hoisted(() => ({ mockIsStreamArriving: vi.fn(async () => false) }));
vi.mock("@/lib/webinar/stream-probe", () => ({ isStreamArriving: mockIsStreamArriving }));

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
  // No partner's stream unless a test adds one (clearAllMocks keeps a mocked value).
  mockDb.externalStream.findFirst.mockResolvedValue(null);
  mockUpdateEventSettings.mockResolvedValue({});
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    settings: { webinar: { sessionId: "anchor1", viewingMode: "hls" } },
  });
  mockDb.eventSession.updateMany.mockResolvedValue({ count: 1 });
  // The anchor started an hour ago: a close now ends the webinar.
  mockDb.eventSession.findFirst.mockResolvedValue({ name: "Webinar", startTime: new Date(Date.now() - 3600_000) });
  mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OK);
  mockIsStreamArriving.mockResolvedValue(false);
  mockControlLiveStream.mockResolvedValue({ ok: true, action: "start", streamKey: "sk-1" });
});

describe("PUT /webinar — hls mode requires a configured live stream", () => {
  it("merges only the changed fields into the CURRENT settings, so a roomOpenedAt written meanwhile survives", async () => {
    const res = await callPut({ lobbyMessage: "Starting soon" });
    expect(res.status).toBe(200);
    const patch = (mockUpdateEventSettings.mock.calls[0] as unknown[])[1] as (c: Record<string, unknown>) => Record<string, unknown>;
    expect(typeof patch).toBe("function");
    const current = { other: 1, webinar: { sessionId: "anchor1", roomOpenedAt: "2026-10-02T09:00:00.000Z", viewingMode: "hls" } };
    expect(patch(current)).toEqual({
      other: 1,
      webinar: { sessionId: "anchor1", roomOpenedAt: "2026-10-02T09:00:00.000Z", viewingMode: "hls", lobbyMessage: "Starting soon" },
    });
  });

  it("room open records roomOpenedAt BEFORE the session goes LIVE", async () => {
    const order: string[] = [];
    mockUpdateEventSettings.mockImplementation(async () => { order.push("openedAt"); return {}; });
    mockDb.eventSession.updateMany.mockImplementation(async () => { order.push("live"); return { count: 1 }; });
    mockControlLiveStream.mockResolvedValue({ ok: true, action: "start", streamKey: "sk-1" });
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(order.slice(0, 2)).toEqual(["openedAt", "live"]);
  });

  it("opening the room clears an earlier Stop stream, so the stream watchdog guards it again (Nov 5, 2026)", async () => {
    mockControlLiveStream.mockResolvedValue({ ok: true, action: "start", streamKey: "sk-1" });
    await callRoom({ open: true });
    const merge = (mockUpdateEventSettings.mock.calls[0] as unknown[])[1] as (c: Record<string, unknown>) => { webinar: Record<string, unknown> };
    const next = merge({ webinar: { sessionId: "anchor1", streamStoppedAt: "2026-11-05T08:00:00Z" } }).webinar;
    expect(next.streamStoppedAt).toBeNull();
    expect(typeof next.roomOpenedAt).toBe("string");
  });

  it("switching to hls sets the stream up itself (the Re-send sync), then saves", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    mockControlLiveStream.mockResolvedValue({ ok: true, action: "sync", streamKey: "k" });
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(200);
    expect(mockControlLiveStream).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", action: "sync" }));
    expect(mockUpdateEventSettings).toHaveBeenCalled();
  });

  it("refuses with Zoom's reason when the stream set-up fails, and saves nothing", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    mockControlLiveStream.mockResolvedValue({ ok: false, code: "ZOOM_API_FAILED", message: "Live streaming is disabled" });
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("HLS_STREAM_NOT_CONFIGURED");
    expect(body.error).toContain("Live streaming is disabled");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1", code: "ZOOM_API_FAILED" }),
      "webinar:hls-mode-stream-setup-failed",
    );
  });

  it("rejects hls when there is no Zoom meeting on the anchor at all", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(400);
  });

  it("accepts hls when the stream is configured", async () => {
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(200);
    expect(mockUpdateEventSettings).toHaveBeenCalled();
  });

  it("a lobby-message-only save on an already-hls event is NOT retro-blocked", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    const res = await callPut({ lobbyMessage: "starting soon" });
    expect(res.status).toBe(200);
    // The gate only fires when the REQUEST sets hls.
    expect(mockDb.zoomMeeting.findFirst).not.toHaveBeenCalled();
  });

  it("switching live polls off closes any open poll on the event (review of polls)", async () => {
    mockDb.livePoll.updateMany.mockResolvedValue({ count: 1 });
    expect((await callPut({ livePolls: false })).status).toBe(200);
    expect(mockDb.livePoll.updateMany.mock.calls[0][0]).toMatchObject({
      where: { eventId: "ev1", status: "OPEN" },
      data: { status: "CLOSED" },
    });
  });

  it("switching live polls on, or any other save, closes nothing", async () => {
    expect((await callPut({ livePolls: true })).status).toBe(200);
    expect((await callPut({ lobbyMessage: "Soon" })).status).toBe(200);
    expect(mockDb.livePoll.updateMany).not.toHaveBeenCalled();
  });

  it("saves the attendee-page branding images", async () => {
    const res = await callPut({ pageLogoUrl: "/uploads/media/l.png", pageBackgroundUrl: "https://cdn.example.com/b.jpg", pageFooterImageUrl: "" });
    expect(res.status).toBe(200);
    const patch = (mockUpdateEventSettings.mock.calls[0] as unknown[])[1] as (c: Record<string, unknown>) => Record<string, unknown>;
    expect((patch({ webinar: {} }).webinar as Record<string, unknown>).pageBackgroundUrl).toBe("https://cdn.example.com/b.jpg");
  });

  it("refuses the CME survey as the end-of-webinar survey, and accepts an open extra one (review of step 4)", async () => {
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-cert", gatesCertificates: true, isActive: true });
    const refused = await callPut({ endSurveyId: "svy-cert" });
    expect(refused.status).toBe(400);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-fb", gatesCertificates: false, isActive: false });
    expect((await callPut({ endSurveyId: "svy-fb" })).status).toBe(400); // closed
    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "svy-fb", gatesCertificates: false, isActive: true });
    expect((await callPut({ endSurveyId: "svy-fb" })).status).toBe(200);
  });

  it("refuses a branding image that is neither an upload nor https", async () => {
    const res = await callPut({ pageBackgroundUrl: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("accepts hls when the session's stream is a partner's, with no Zoom webinar at all", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    mockDb.externalStream.findFirst.mockResolvedValue({ streamKey: "px-1", streamStatus: "IDLE" });
    const res = await callPut({ viewingMode: "hls" });
    expect(res.status).toBe(200);
    expect(mockControlLiveStream).not.toHaveBeenCalled();
  });

  it("a partner-produced webinar cannot be switched to the Zoom embed: there is no Zoom to embed", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      settings: { webinar: { sessionId: "anchor1", viewingMode: "hls", source: "external" } },
    });
    const res = await callPut({ viewingMode: "zoom" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EXTERNAL_VIDEO_SOURCE");
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    // Other settings of the same webinar still save.
    expect((await callPut({ lobbyMessage: "Starting soon" })).status).toBe(200);
  });

  it("switching to zoom mode never checks the stream", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    const res = await callPut({ viewingMode: "zoom" });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findFirst).not.toHaveBeenCalled();
  });
});

describe("POST /webinar/room — opening in hls mode is the final gate", () => {
  it("refuses to open the room when hls mode has no configured stream", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
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
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    const res = await callRoom({ open: false });
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "COMPLETED" } }),
    );
  });

  it("a close BEFORE the scheduled start is a rehearsal: the session goes back to SCHEDULED (review of 66d8ef6e)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ name: "Webinar", status: "LIVE", startTime: new Date(Date.now() + 86_400_000) });
    const res = await callRoom({ open: false });
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "SCHEDULED" } }),
    );
  });

  it("a rehearsal close keeps a CANCELLED anchor cancelled (review of fb4459d0)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ name: "Webinar", status: "CANCELLED", startTime: new Date(Date.now() + 86_400_000) });
    await callRoom({ open: false });
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "CANCELLED" } }),
    );
  });

  it("asks Zoom to start the stream when it is not arriving yet", async () => {
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(mockControlLiveStream).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
    expect((await res.json()).stream).toEqual({ ok: true });
  });

  it("leaves a stream that is already arriving alone (started and previewed before opening)", async () => {
    mockIsStreamArriving.mockResolvedValue(true);
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "LIVE" } }),
    );
    expect(mockControlLiveStream).not.toHaveBeenCalled();
    expect(mockIsStreamArriving).toHaveBeenCalledWith("sk-1", { fresh: true });
    expect((await res.json()).stream).toEqual({ ok: true, alreadyLive: true });
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev1" }),
      "webinar:room-stream-already-arriving",
    );
  });

  it("closing still stops the stream, whatever the probe says", async () => {
    mockIsStreamArriving.mockResolvedValue(true);
    await callRoom({ open: false });
    expect(mockControlLiveStream).toHaveBeenCalledWith(expect.objectContaining({ action: "stop" }));
  });

  it("a partner's stream: the room opens and closes without asking Zoom anything", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    mockDb.externalStream.findFirst.mockResolvedValue({ streamKey: "px-1", streamStatus: "IDLE" });
    const opened = await callRoom({ open: true });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ open: true, sessionId: "anchor1", status: "LIVE" });
    const closed = await callRoom({ open: false });
    expect(closed.status).toBe(200);
    expect(mockControlLiveStream).not.toHaveBeenCalled();
  });

  it("zoom viewing mode opens without a stream check", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      settings: { webinar: { sessionId: "anchor1", viewingMode: "zoom" } },
    });
    mockDb.zoomMeeting.findFirst.mockResolvedValue(STREAM_OFF);
    const res = await callRoom({ open: true });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findFirst).not.toHaveBeenCalled();
  });
});

describe("PUT /webinar: the uploaded replay link (Nov 10, 2026)", () => {
  const patchOf = () =>
    ((mockUpdateEventSettings.mock.calls[0] as unknown[])[1] as (c: Record<string, unknown>) => Record<string, unknown>)({ webinar: { sessionId: "anchor1" } });

  it("saves a Vimeo video link, trimmed, beside the switch the console sends with it", async () => {
    const res = await callPut({ replayUrl: "  https://vimeo.com/123456789/abcdef1234 ", showRecording: true });
    expect(res.status).toBe(200);
    expect(patchOf()).toEqual({
      webinar: { sessionId: "anchor1", replayUrl: "https://vimeo.com/123456789/abcdef1234", showRecording: true },
    });
  });

  it("an empty string clears it and leaves the switch alone", async () => {
    const res = await callPut({ replayUrl: "" });
    expect(res.status).toBe(200);
    expect(patchOf()).toEqual({ webinar: { sessionId: "anchor1", replayUrl: "" } });
  });

  it.each([
    "https://zoom.us/rec/play/abc",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/showcase/7654321",
    "https://vimeo.com.evil.example/123456789",
    "javascript:alert(1)",
  ])("refuses %s with 400, logged, and writes nothing", async (replayUrl) => {
    const res = await callPut({ replayUrl });
    expect(res.status).toBe(400);
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.anything(), "webinar:settings-validation-failed");
  });
});
