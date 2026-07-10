/**
 * Program/agenda review — BLOCKER B1 + B2 (July 10, 2026).
 *
 * B1: GET /api/events/[eventId]/sessions has no denyReviewer, and
 *     buildEventAccessWhere grants org-null attendee roles the event by
 *     linkage — so a REGISTRANT could pull zoomMeeting.startUrl (the Zoom HOST
 *     link), streamKey and passcode, and take host control of a live webinar.
 * B2: the public session-detail route returned recordingUrl +
 *     recordingPassword to anonymous callers, served DRAFT events, and had no
 *     rate limit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockOrgCtx, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findMany: vi.fn(), findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockOrgCtx: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { set: () => {} },
    }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockOrgCtx() }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => mockRateLimit(),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/webinar", () => ({ readSponsors: () => [] }));

import { GET as SESSIONS_GET } from "@/app/api/events/[eventId]/sessions/route";
import { GET as DETAIL_GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/detail/route";

const ZOOM_ROW = {
  id: "z1",
  joinUrl: "https://zoom.us/j/1",
  startUrl: "https://zoom.us/s/1?zak=HOST_SECRET",
  passcode: "hunter2",
  streamKey: "rtmp-secret",
  streamStatus: "ACTIVE",
};

const req = () => new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgCtx.mockResolvedValue(null);
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.eventSession.findMany.mockResolvedValue([{ id: "s1", name: "Keynote", zoomMeeting: { ...ZOOM_ROW } }]);
});

describe("B1 — sessions list must not leak Zoom host credentials", () => {
  const sessionsParams = { params: Promise.resolve({ eventId: "ev1" }) };

  it.each(["REGISTRANT", "SUBMITTER", "REVIEWER", "MEMBER", "ONSITE"])(
    "redacts startUrl/streamKey/passcode for %s (who reaches the event via linkage)",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: null } });
      const res = await SESSIONS_GET(req(), sessionsParams);
      const body = await res.json();
      expect(body[0].zoomMeeting.startUrl).toBeNull();
      expect(body[0].zoomMeeting.streamKey).toBeNull();
      expect(body[0].zoomMeeting.passcode).toBeNull();
      // Attendee join link is legitimately theirs.
      expect(body[0].zoomMeeting.joinUrl).toBe("https://zoom.us/j/1");
    },
  );

  it.each(["ADMIN", "SUPER_ADMIN", "ORGANIZER"])("keeps host credentials for %s", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: "org1" } });
    const res = await SESSIONS_GET(req(), sessionsParams);
    const body = await res.json();
    expect(body[0].zoomMeeting.startUrl).toBe("https://zoom.us/s/1?zak=HOST_SECRET");
    expect(body[0].zoomMeeting.streamKey).toBe("rtmp-secret");
  });

  it("keeps host credentials for an API-key caller (admin-equivalent, org-scoped)", async () => {
    mockAuth.mockResolvedValue(null);
    mockOrgCtx.mockResolvedValue({ organizationId: "org1", role: null });
    const res = await SESSIONS_GET(req(), sessionsParams);
    const body = await res.json();
    expect(body[0].zoomMeeting.startUrl).toBe("https://zoom.us/s/1?zak=HOST_SECRET");
  });
});

describe("B2 — public session detail must not leak recording credentials or DRAFT events", () => {
  const detailParams = { params: Promise.resolve({ slug: "ev", sessionId: "s1" }) };

  beforeEach(() => {
    mockAuth.mockResolvedValue(null); // anonymous
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev", status: "PUBLISHED", eventType: "WEBINAR",
      bannerImage: null, timezone: "Asia/Dubai", settings: {}, organizationId: "org1",
      organization: { name: "Org" },
    });
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", name: "Keynote", description: null, startTime: new Date(0), endTime: new Date(0),
      location: null, capacity: null, status: "COMPLETED", track: null,
      speakers: [], topics: [],
      zoomMeeting: { recordingStatus: "AVAILABLE" },
    });
  });

  it("never returns recordingUrl or recordingPassword to an anonymous caller", async () => {
    const res = await DETAIL_GET(req(), detailParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.session.zoomMeeting).toEqual({ recordingStatus: "AVAILABLE" });
    expect(JSON.stringify(body)).not.toContain("recordingPassword");
    expect(JSON.stringify(body)).not.toContain("recordingUrl");
  });

  it("404s a DRAFT event for an anonymous caller (no existence leak)", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev", status: "DRAFT", eventType: "WEBINAR",
      bannerImage: null, timezone: "Asia/Dubai", settings: {}, organizationId: "org1",
      organization: { name: "Org" },
    });
    const res = await DETAIL_GET(req(), detailParams);
    expect(res.status).toBe(404);
    expect(mockDb.eventSession.findFirst).not.toHaveBeenCalled();
  });

  it("allows org staff to preview a DRAFT event (organizer end-to-end testing)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ORGANIZER", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev", status: "DRAFT", eventType: "WEBINAR",
      bannerImage: null, timezone: "Asia/Dubai", settings: {}, organizationId: "org1",
      organization: { name: "Org" },
    });
    const res = await DETAIL_GET(req(), detailParams);
    expect(res.status).toBe(200);
  });

  it("does NOT let an org-staff role from ANOTHER org preview the DRAFT", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ORGANIZER", organizationId: "orgB" } });
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev", status: "DRAFT", eventType: "WEBINAR",
      bannerImage: null, timezone: "Asia/Dubai", settings: {}, organizationId: "org1",
      organization: { name: "Org" },
    });
    const res = await DETAIL_GET(req(), detailParams);
    expect(res.status).toBe(404);
  });

  it("is rate limited (429) — it was the only public session route without one", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await DETAIL_GET(req(), detailParams);
    expect(res.status).toBe(429);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });
});
