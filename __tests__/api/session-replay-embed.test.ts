/**
 * The organiser's uploaded replay on the attendee page (Nov 10, 2026).
 *
 * The public detail route says only WHICH replay is on offer; the Vimeo address itself comes from
 * the registration-gated recording route, as Zoom's recording link always has. These run the real
 * rule (webinar/replay.ts), the real settings readers and the real viewer rule over a mocked db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/sponsors", () => ({ getSponsors: vi.fn(async () => []) }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => mockRateLimit() }));

import { GET as DETAIL_GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/detail/route";
import { GET as RECORDING_GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/recording/route";

const VIMEO = "https://vimeo.com/123456789/abcdef1234";
const EMBED = "https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1";
const PAST = new Date("2026-11-10T08:30:00Z");
const FUTURE = new Date(Date.now() + 86_400_000);

const req = () => new Request("http://localhost/x");
const params = { params: Promise.resolve({ slug: "ev", sessionId: "s1" }) };
const event = (webinar: Record<string, unknown>, eventType = "WEBINAR") => ({
  id: "ev1", name: "Ev", slug: "ev", status: "PUBLISHED", eventType,
  bannerImage: null, bannerImageMobile: null, timezone: "Asia/Dubai",
  settings: { webinar: { sessionId: "s1", ...webinar } },
  organizationId: "org1", organization: { name: "Org", settings: {} },
});
const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "Keynote", description: null, startTime: PAST, endTime: PAST,
  location: null, capacity: null, status: "COMPLETED", type: "SESSION", track: null, speakers: [], topics: [],
  zoomMeeting: null,
  ...over,
});
const ZOOM = { recordingUrl: "https://zoom.us/rec/play/1", recordingPassword: "pw", recordingStatus: "AVAILABLE" };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null } };

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(null);
  mockDb.event.findFirst.mockResolvedValue(event({ showRecording: true, replayUrl: VIMEO }));
  mockDb.eventSession.findFirst.mockResolvedValue(session());
  mockDb.registration.findFirst.mockResolvedValue({ id: "r1" });
});

describe("public detail: which replay, never its address", () => {
  const detail = async () => (await DETAIL_GET(req(), params)).json();

  it("says the uploaded replay is on offer, to anyone, without the Vimeo link or id", async () => {
    const body = await detail();
    expect(body.session.replayKind).toBe("embed");
    const text = JSON.stringify(body);
    expect(text).not.toContain("vimeo");
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("abcdef1234");
  });

  it("says nothing while the organiser's switch is off", async () => {
    mockDb.event.findFirst.mockResolvedValue(event({ replayUrl: VIMEO }));
    const body = await detail();
    expect(body.session.replayKind).toBeNull();
    expect(body.session.recordingHidden).toBe(true);
  });

  it("a link saved before the webinar is over offers nothing yet", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue(session({ status: "SCHEDULED", endTime: FUTURE }));
    expect((await detail()).session.replayKind).toBeNull();
    mockDb.eventSession.findFirst.mockResolvedValue(session({ status: "LIVE" }));
    expect((await detail()).session.replayKind).toBeNull();
  });

  it("with no link, Zoom's recording once fetched; a conference as before", async () => {
    mockDb.event.findFirst.mockResolvedValue(event({ showRecording: true }));
    mockDb.eventSession.findFirst.mockResolvedValue(session({ zoomMeeting: { recordingStatus: "AVAILABLE" } }));
    expect((await detail()).session.replayKind).toBe("zoom");
    mockDb.event.findFirst.mockResolvedValue(event({}, "CONFERENCE"));
    expect((await detail()).session.replayKind).toBe("zoom");
  });
});

describe("recording route: the uploaded replay, behind the same gate as Zoom's", () => {
  const recording = () => RECORDING_GET(req(), params);

  it("a signed-in, registered attendee gets the player address, built from the id", async () => {
    mockAuth.mockResolvedValue(attendee);
    const res = await recording();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "embed", embedUrl: EMBED });
    // The viewer rule ran: this account's confirmed, settled registration on this event.
    expect(mockDb.registration.findFirst.mock.calls[0][0].where).toMatchObject({
      eventId: "ev1",
      userId: "u1",
      status: { in: ["CONFIRMED", "CHECKED_IN"] },
    });
  });

  it("it wins over Zoom's recording, whose link and passcode are then not sent", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.eventSession.findFirst.mockResolvedValue(session({ zoomMeeting: ZOOM }));
    const body = await (await recording()).json();
    expect(body).toEqual({ kind: "embed", embedUrl: EMBED });
    expect(JSON.stringify(body)).not.toContain("zoom.us");
  });

  it("anonymous: 401, nothing of the replay", async () => {
    const res = await recording();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("vimeo");
  });

  it("signed in but not registered (or pending, or unpaid): 403, nothing of the replay", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await recording();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("vimeo");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "session-recording:denied:not-registered");
  });

  it("the organiser's switch off: 404 for a registered attendee, logged", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.event.findFirst.mockResolvedValue(event({ showRecording: false, replayUrl: VIMEO }));
    const res = await recording();
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("vimeo");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "session-recording:hidden-by-organiser");
  });

  it("before the webinar is over the link is not served: 404, or Zoom's recording if there is one", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.eventSession.findFirst.mockResolvedValue(session({ status: "LIVE" }));
    const none = await recording();
    expect(none.status).toBe(404);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "session-recording:not-available");

    mockDb.eventSession.findFirst.mockResolvedValue(session({ status: "LIVE", zoomMeeting: ZOOM }));
    expect(await (await recording()).json()).toMatchObject({ kind: "zoom", recordingUrl: ZOOM.recordingUrl, recordingPassword: "pw" });
  });

  it("a stored link that is not a Vimeo video is never served as a player", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.event.findFirst.mockResolvedValue(event({ showRecording: true, replayUrl: "https://evil.example/player" }));
    const res = await recording();
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("evil.example");
  });

  it("no link: Zoom's recording exactly as before, now labelled", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.event.findFirst.mockResolvedValue(event({ showRecording: true }));
    mockDb.eventSession.findFirst.mockResolvedValue(session({ zoomMeeting: ZOOM }));
    expect(await (await recording()).json()).toEqual({
      kind: "zoom",
      recordingUrl: ZOOM.recordingUrl,
      recordingPassword: "pw",
      recordingStatus: "AVAILABLE",
    });
  });
});
