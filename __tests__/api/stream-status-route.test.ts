/**
 * GET /api/public/events/[slug]/sessions/[sessionId]/stream-status — M3
 * (program/agenda review): the HLS playback URL embeds the streamKey, which is
 * ALSO the RTMP publish credential on MediaMTX. The route used to hand
 * hlsUrl + hlsOriginUrl + the raw streamKey to ANY caller, bypassing the
 * registration gate zoom-join enforces. Pins the new contract:
 *  - anonymous / unregistered callers get the bare liveness flag only
 *  - registered attendees + org staff get the URLs
 *  - streamKey is NEVER in the response, for anyone
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockDb: {
    event: { findFirst: vi.fn() },
    externalStream: { findFirst: vi.fn(), updateMany: vi.fn() }, zoomMeeting: { findFirst: vi.fn(), updateMany: vi.fn() },
    registration: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
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
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getClientIp: () => "127.0.0.1",
}));

import { GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/stream-status/route";
import { resetRoomOpenCache } from "@/lib/webinar/viewer-entitlement";

// The route probes MediaMTX with a global fetch — always "live" here. The
// probe result is cached per streamKey (3s TTL), so each test uses a DISTINCT
// streamKey; the viewer-auth cache is per (userId, eventId), so tests that
// need different registration outcomes use distinct user ids.
const fetchMock = vi.fn(async () => ({ ok: true }));
vi.stubGlobal("fetch", fetchMock);

let keyCounter = 0;
function nextStreamKey() {
  return `sk-${++keyCounter}`;
}

function call() {
  const req = { headers: new Headers() } as unknown as Request;
  return GET(req, { params: Promise.resolve({ slug: "evt", sessionId: "sess1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // No partner's stream unless a test adds one (clearAllMocks keeps a mocked value).
  mockDb.externalStream.findFirst.mockResolvedValue(null);
  fetchMock.mockResolvedValue({ ok: true });
  mockAuth.mockResolvedValue(null);
  resetRoomOpenCache();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    organizationId: "org1",
    eventType: "WEBINAR",
    status: "PUBLISHED",
    settings: { webinar: { sessionId: "sess1" } },
  });
  // The producer has opened the room (anchor session LIVE).
  mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE" });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({
    liveStreamEnabled: true,
    streamKey: nextStreamKey(),
    streamStatus: "ACTIVE",
  });
  mockDb.zoomMeeting.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.findFirst.mockResolvedValue(null);
});

describe("stream-status — M3 credential gating", () => {
  it("anonymous caller gets liveness only — no URLs, no streamKey", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "active" });
    expect(body).not.toHaveProperty("hlsUrl");
    expect(body).not.toHaveProperty("hlsOriginUrl");
    expect(body).not.toHaveProperty("streamKey");
  });

  it("authenticated but NOT registered → liveness only + denial logged", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-unreg-1", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await call();
    const body = await res.json();
    expect(body).toEqual({ status: "active" });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-unreg-1", eventId: "ev1" }),
      "public/stream-status:urls-denied-not-registered",
    );
  });

  it("registered attendee gets the HLS URLs — but NEVER the raw streamKey", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-reg-1", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg1" });
    const res = await call();
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.hlsUrl).toContain("/stream/live/");
    expect(body.hlsOriginUrl).toContain("/stream/live/");
    expect(body).not.toHaveProperty("streamKey");
    // The registration lookup is scoped to this event and to a registration that may watch
    // (security review W-01: confirmed or checked in, never pending approval).
    expect(mockDb.registration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          eventId: "ev1",
          userId: "u-reg-1",
          status: { in: ["CONFIRMED", "CHECKED_IN"] },
        }),
      }),
    );
  });

  it("a partner's stream is served the same way, and its status is written on its own row", async () => {
    const key = nextStreamKey();
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    mockDb.externalStream.findFirst.mockResolvedValue({ streamKey: key, streamStatus: "IDLE" });
    mockAuth.mockResolvedValue({ user: { id: "u-reg-ext", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg-ext" });
    const body = await (await call()).json();
    expect(body.status).toBe("active");
    expect(body.hlsUrl).toContain(`/stream/live/${key}/index.m3u8`);
    expect(body).not.toHaveProperty("streamKey");
    expect(mockDb.externalStream.updateMany).toHaveBeenCalledWith({
      where: { sessionId: "sess1", eventId: "ev1" },
      data: { streamStatus: "ACTIVE", organizationId: "org1" },
    });
    expect(mockDb.zoomMeeting.updateMany).not.toHaveBeenCalled();
  });

  it("a registered attendee gets NO URLs while the room is closed: a rehearsal stream is not theirs (W-02)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-reg-2", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue({ id: "reg2" });
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "SCHEDULED" });
    const body = await (await call()).json();
    expect(body).toEqual({ status: "active", roomOpen: false });
    // The room is read from the event's ANCHOR session, bound to the event.
    expect(mockDb.eventSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sess1", eventId: "ev1" } }),
    );
  });

  it("staff keep their preview while the room is closed", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-staff-3", role: "ADMIN", organizationId: "org1" } });
    mockDb.eventSession.findFirst.mockResolvedValue({ status: "SCHEDULED" });
    const body = await (await call()).json();
    expect(body.hlsUrl).toBeTruthy();
  });

  it("org staff of the SAME org get URLs without a registration lookup", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-staff-1", role: "ADMIN", organizationId: "org1" } });
    const res = await call();
    const body = await res.json();
    expect(body.hlsUrl).toBeTruthy();
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("the WEBINARS producer role gets URLs too, for the console's stream preview", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-prod-1", role: "WEBINARS", organizationId: "org1" } });
    const body = await (await call()).json();
    expect(body.hlsUrl).toBeTruthy();
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("the WEBINARS role gets NO URLs on a conference event (its host control stops at webinars)", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE" });
    mockAuth.mockResolvedValue({ user: { id: "u-prod-2", role: "WEBINARS", organizationId: "org1" } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body).toEqual({ status: "active" });
  });

  it("a read-only MEMBER is still treated as an attendee (no host-role bypass)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-mem-1", role: "MEMBER", organizationId: "org1" } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body).toEqual({ status: "active" });
  });

  it("staff of a DIFFERENT org are treated as attendees (no cross-org staff bypass)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-staff-2", role: "ADMIN", organizationId: "orgB" } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body).toEqual({ status: "active" });
  });

  it("no live-stream-enabled meeting → unavailable", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body).toEqual({ status: "unavailable" });
  });
});
