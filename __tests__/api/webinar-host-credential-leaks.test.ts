/**
 * Webinar host-credential redaction (Aug 27, 2026) — the July-10 B1 fix
 * redacted Zoom host credentials (startUrl/streamKey/passcode) on the
 * sessions-LIST route but left two sibling GETs returning them raw:
 *   - GET /api/events/[eventId]/webinar               (webinar console)
 *   - GET /api/events/[eventId]/sessions/[sessionId]/zoom
 * A read-only MEMBER (org-wide event access) could take the host startUrl and
 * seize control of any org webinar, plus the raw RTMP streamKey. These tests
 * pin that both GETs now redact for non-host roles and keep for host roles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
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
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (s: { user?: { organizationId?: string } }) =>
    s?.user?.organizationId ? { orgId: s.user.organizationId } : { error: { status: 403 } },
}));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
// buildEventAccessWhere is exercised for real elsewhere; here every role that
// reaches these routes matches the event, which is the leak precondition.
vi.mock("@/lib/event-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/event-access")>()),
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null, WEBINAR_STAFF_ALLOW: [] }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/webinar", () => ({
  readWebinarSettings: (s: unknown) => (s as { webinar?: unknown } | null)?.webinar ?? null,
  webinarSecondRoomViolation: () => null,
}));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: vi.fn() }));
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: vi.fn() }));
vi.mock("@/lib/webinar/lobby-video", () => ({ isValidLobbyVideoUrl: () => true }));
vi.mock("@/lib/zoom", () => ({
  isZoomConfigured: vi.fn(), createZoomMeeting: vi.fn(), createZoomWebinar: vi.fn(),
  createWebinarSeries: vi.fn(), getZoomMeeting: vi.fn(), getZoomWebinar: vi.fn(),
  updateZoomMeeting: vi.fn(), updateZoomWebinar: vi.fn(), enableZoomLiveStreaming: vi.fn(),
  enableWebinarLiveStreaming: vi.fn(), enableWebinarQA: vi.fn(),
}));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: vi.fn() }));
// NB: @/lib/zoom-visibility is intentionally NOT mocked — the real redaction
// predicate is exactly what these tests exercise.

import { GET as WEBINAR_GET } from "@/app/api/events/[eventId]/webinar/route";
import { GET as ZOOM_GET } from "@/app/api/events/[eventId]/sessions/[sessionId]/zoom/route";

const ZOOM_ROW = {
  id: "z1",
  zoomMeetingId: "123",
  meetingType: "WEBINAR",
  joinUrl: "https://zoom.us/j/1",
  startUrl: "https://zoom.us/s/1?zak=HOST_SECRET",
  passcode: "hunter2",
  streamKey: "rtmp-secret",
  recordingUrl: "https://zoom.us/rec/REC",
  recordingPassword: "recpass",
  recordingStatus: "NOT_REQUESTED",
};
const req = () => new Request("http://localhost/x");
const webinarParams = { params: Promise.resolve({ eventId: "ev1" }) };
const zoomParams = { params: Promise.resolve({ eventId: "ev1", sessionId: "s1" }) };
const user = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", name: "W", slug: "w", eventType: "WEBINAR", status: "DRAFT",
    settings: { webinar: { sessionId: "s1" } }, organizationId: "org1",
  });
  mockDb.eventSession.findFirst.mockResolvedValue({
    id: "s1", name: "Anchor", startTime: new Date(0), endTime: new Date(0), description: null, status: "SCHEDULED",
  });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ ...ZOOM_ROW });
});

const NON_HOST = ["MEMBER", "ONSITE"] as const;
const HOST = ["ADMIN", "SUPER_ADMIN", "ORGANIZER", "WEBINARS"] as const;

describe("GET /webinar (console) — host-credential redaction", () => {
  it.each(NON_HOST)("redacts startUrl + passcode for %s", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const body = await (await WEBINAR_GET(req(), webinarParams)).json();
    expect(body.zoomMeeting.startUrl).toBeNull();
    expect(body.zoomMeeting.passcode).toBeNull();
    // attendee link stays theirs
    expect(body.zoomMeeting.joinUrl).toBe("https://zoom.us/j/1");
  });

  it.each(HOST)("keeps host credentials for %s", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const body = await (await WEBINAR_GET(req(), webinarParams)).json();
    expect(body.zoomMeeting.startUrl).toBe("https://zoom.us/s/1?zak=HOST_SECRET");
    expect(body.zoomMeeting.passcode).toBe("hunter2");
  });
});

describe("GET /sessions/[id]/zoom — host-credential redaction", () => {
  it.each(NON_HOST)("redacts startUrl + streamKey + passcode for %s", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const body = await (await ZOOM_GET(req(), zoomParams)).json();
    expect(body.startUrl).toBeNull();
    expect(body.streamKey).toBeNull();
    expect(body.passcode).toBeNull();
    expect(body.joinUrl).toBe("https://zoom.us/j/1");
  });

  it.each(HOST)("keeps host credentials for %s", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const body = await (await ZOOM_GET(req(), zoomParams)).json();
    expect(body.startUrl).toBe("https://zoom.us/s/1?zak=HOST_SECRET");
    expect(body.streamKey).toBe("rtmp-secret");
    expect(body.passcode).toBe("hunter2");
  });
});
