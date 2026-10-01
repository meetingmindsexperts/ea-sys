/**
 * Custom stream controls (Oct 1, 2026): the shared control function the
 * producer's buttons and the room toggle both call, and the MediaMTX publish
 * authorisation webhook. Zoom and the database are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, zoomApiRequestSpy, enableWebinarSpy, enableMeetingSpy } = vi.hoisted(() => ({
  mockDb: {
    zoomMeeting: { findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
  zoomApiRequestSpy: vi.fn(),
  enableWebinarSpy: vi.fn(),
  enableMeetingSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/zoom/client", () => ({ zoomApiRequest: zoomApiRequestSpy }));
vi.mock("@/lib/zoom/meetings", () => ({
  enableWebinarLiveStreaming: enableWebinarSpy,
  enableZoomLiveStreaming: enableMeetingSpy,
}));

import { controlWebinarLiveStream, rtmpIngestUrl } from "@/lib/webinar/livestream";
import { POST as mediamtxAuth } from "@/app/api/webhooks/mediamtx-auth/route";

const KEY = "0123456789abcdef0123456789abcdef";
const base = {
  organizationId: "org1",
  eventId: "ev1",
  eventSlug: "test-webinar",
  sessionId: "s1",
  sessionName: "Test Webinar",
  userId: "u1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.zoomMeeting.update.mockResolvedValue({});
});

describe("controlWebinarLiveStream", () => {
  it("start calls Zoom's livestream status endpoint for a webinar", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: true, streamKey: KEY,
    });
    zoomApiRequestSpy.mockResolvedValue(undefined);
    const res = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(res.ok).toBe(true);
    expect(zoomApiRequestSpy).toHaveBeenCalledWith(
      "org1", "PATCH", "/webinars/999/livestream/status",
      expect.objectContaining({ action: "start" }),
    );
  });

  it("stop on a plain meeting uses the meetings path and sends no settings", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "123", meetingType: "MEETING", liveStreamEnabled: true, streamKey: KEY,
    });
    await controlWebinarLiveStream({ ...base, action: "stop" });
    expect(zoomApiRequestSpy).toHaveBeenCalledWith("org1", "PATCH", "/meetings/123/livestream/status", { action: "stop" });
  });

  it("start refuses when streaming was never set up", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: false, streamKey: null,
    });
    const res = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(res).toMatchObject({ ok: false, code: "STREAM_NOT_CONFIGURED" });
    expect(zoomApiRequestSpy).not.toHaveBeenCalled();
  });

  it("start before the host has started explains it in plain words", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: true, streamKey: KEY,
    });
    zoomApiRequestSpy.mockRejectedValue(new Error("Zoom API error: 400 Webinar has not started (code: 3000)"));
    const res = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(res).toMatchObject({ ok: false, code: "ZOOM_API_FAILED" });
    expect(!res.ok && res.message).toMatch(/not live in Zoom yet/);
  });

  it("Zoom 429 (one start per 30 s) and a stop on a webinar that is not live get plain words", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: true, streamKey: KEY,
    });
    zoomApiRequestSpy.mockRejectedValueOnce(new Error("Zoom API error: 429 Too many requests submitted to start the live stream (code: 429)"));
    const a = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(!a.ok && a.message).toMatch(/30 seconds/);
    zoomApiRequestSpy.mockRejectedValueOnce(new Error("Zoom API error: 400 Webinar 82,056,527,587 has not started. (code: 200)"));
    const b = await controlWebinarLiveStream({ ...base, action: "stop" });
    expect(!b.ok && b.message).toMatch(/no stream to stop/);
  });

  it("Zoom 3001 (webinar gone) points at the provisioner, not a retry", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: true, streamKey: KEY,
    });
    zoomApiRequestSpy.mockRejectedValue(new Error("Zoom API error: 404 Webinar does not exist (code: 3001)"));
    const res = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(!res.ok && res.message).toMatch(/provisioner/);
  });

  it("sync turns streaming on for a session created without it and stores a new key", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: false, streamKey: null,
    });
    const res = await controlWebinarLiveStream({ ...base, action: "sync" });
    expect(res.ok).toBe(true);
    expect(enableWebinarSpy).toHaveBeenCalledWith("org1", "999", rtmpIngestUrl(), expect.stringMatching(/^[a-f0-9]{32}$/), expect.stringContaining("/e/test-webinar/session/s1"));
    expect(mockDb.zoomMeeting.update).toHaveBeenCalledWith({
      where: { id: "zm1" },
      data: { liveStreamEnabled: true, streamKey: expect.stringMatching(/^[a-f0-9]{32}$/) },
    });
  });

  it("sync keeps an existing key so a running push is not broken", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: true, streamKey: KEY,
    });
    await controlWebinarLiveStream({ ...base, action: "sync" });
    expect(enableWebinarSpy.mock.calls[0][3]).toBe(KEY);
  });

  it("sync does not save when Zoom refuses", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({
      id: "zm1", zoomMeetingId: "999", meetingType: "WEBINAR", liveStreamEnabled: false, streamKey: null,
    });
    enableWebinarSpy.mockRejectedValue(new Error("Zoom API error: 400 nope"));
    const res = await controlWebinarLiveStream({ ...base, action: "sync" });
    expect(res).toMatchObject({ ok: false, code: "ZOOM_API_FAILED" });
    expect(mockDb.zoomMeeting.update).not.toHaveBeenCalled();
  });

  it("no Zoom meeting is a clear refusal", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    const res = await controlWebinarLiveStream({ ...base, action: "start" });
    expect(res).toMatchObject({ ok: false, code: "NO_ZOOM_MEETING" });
  });
});

describe("MediaMTX publish authorisation webhook", () => {
  const call = (body: unknown) =>
    mediamtxAuth(
      new Request("http://localhost/api/webhooks/mediamtx-auth", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
        body: JSON.stringify(body),
      }),
    );

  it("allows a publish on a known, enabled key", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ id: "zm1", eventId: "ev1" });
    const res = await call({ action: "publish", path: `live/${KEY}`, protocol: "rtmp" });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { streamKey: KEY, liveStreamEnabled: true } }),
    );
  });

  it("refuses a publish on an unknown key", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    expect((await call({ action: "publish", path: `live/${KEY}` })).status).toBe(403);
  });

  it("refuses a publish on any other path without touching the database", async () => {
    expect((await call({ action: "publish", path: "live/anything-goes" })).status).toBe(403);
    expect((await call({ action: "publish", path: "other/x" })).status).toBe(403);
    expect(mockDb.zoomMeeting.findFirst).not.toHaveBeenCalled();
  });

  it("fails closed when the lookup errors", async () => {
    mockDb.zoomMeeting.findFirst.mockRejectedValue(new Error("db down"));
    expect((await call({ action: "publish", path: `live/${KEY}` })).status).toBe(503);
  });

  it("keeps reading open, refuses admin actions, rejects a malformed body", async () => {
    expect((await call({ action: "read", path: `live/${KEY}` })).status).toBe(200);
    expect((await call({ action: "playback", path: `live/${KEY}` })).status).toBe(200);
    expect((await call({ action: "api", path: "" })).status).toBe(403);
    expect((await call({ nope: true })).status).toBe(400);
  });
});
