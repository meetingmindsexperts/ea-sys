/**
 * GET /api/public/events/[slug]/sessions/[sessionId]/zoom-join — the join
 * WINDOW gate (Aug 10, 2026).
 *
 * The route allows a join when the session is LIVE, starts within 15 minutes,
 * or the event is DRAFT. It also computes `isOrgStaff` whose own comment says
 * it exists "for QA / host testing" — but the window check below ignored it,
 * so a producer could not open their own attendee view to rehearse a PUBLISHED
 * webinar. Prod logged five refusals in one morning from the organizer's own
 * account, one against a session starting the NEXT DAY. The only workaround was
 * keeping the event in DRAFT, i.e. publishing silently removed the ability to
 * rehearse.
 *
 * These pin BOTH directions, because the fix widens access: staff get through,
 * and a registered non-staff attendee is still held to the clock. The second
 * assertion is the one that matters — a bypass that leaked to attendees would
 * hand out SDK signatures for a webinar that has not started.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger, mockSignature } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockSignature: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), findMany: vi.fn() },
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
vi.mock("@/lib/public-event", () => ({ publicEventWhere: async () => ({ slug: "evt" }) }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/zoom", () => ({
  generateZoomSignatureForOrg: () => mockSignature(),
}));

import { GET } from "@/app/api/public/events/[slug]/sessions/[sessionId]/zoom-join/route";
import { resetRoomOpenCache } from "@/lib/webinar/viewer-entitlement";

const ORG = "org1";
const DAY_MS = 24 * 3600_000;

function call() {
  const req = { headers: new Headers() } as unknown as Request;
  return GET(req, { params: Promise.resolve({ slug: "evt", sessionId: "sess1" }) });
}

/** A session comfortably outside the 15-minute window — tomorrow. */
function sessionStartingTomorrow() {
  const start = new Date(Date.now() + DAY_MS);
  return {
    id: "sess1",
    name: "Anchor",
    startTime: start,
    endTime: new Date(start.getTime() + 3600_000),
    status: "SCHEDULED",
    zoomMeeting: {
      zoomMeetingId: "9999",
      joinUrl: "https://zoom.us/j/9999",
      passcode: "pw",
      meetingType: "WEBINAR",
      liveStreamEnabled: false,
      streamKey: null,
      streamStatus: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSignature.mockResolvedValue(null); // → "url" mode, keeps the assertions simple
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1",
    organizationId: ORG,
    status: "PUBLISHED",
  });
  mockDb.eventSession.findFirst.mockResolvedValue(sessionStartingTomorrow());
  mockDb.registration.findMany.mockResolvedValue([]);
  resetRoomOpenCache();
});

describe("zoom-join window gate", () => {
  it("lets ORG STAFF preview a published webinar outside the join window", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-staff", role: "ORGANIZER", organizationId: ORG, email: "o@x.com" },
    });

    const res = await call();
    expect(res.status).toBe(200);
    // Never consults Registration for staff — that carve-out already existed.
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("records the staff preview so an out-of-window join is still traceable", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-staff", role: "ADMIN", organizationId: ORG, email: "a@x.com" },
    });

    const res = await call();
    // Asserts the STATUS too, deliberately. The log line lives in its own
    // condition, so a log-only assertion still passes with the bypass removed —
    // i.e. it would pass against the exact bug it exists to catch. Caught by
    // mutation-testing this file.
    expect(res.status).toBe(200);
    const msgs = mockApiLogger.info.mock.calls.map((c) => c[1]);
    expect(msgs).toContain("zoom:join-staff-preview-outside-window");
  });

  it("still refuses a REGISTERED attendee outside the window (the bypass must not leak)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-att", role: "REGISTRANT", organizationId: null, email: "r@x.com" },
    });
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg1",
      attendee: { firstName: "A", lastName: "B", email: "r@x.com" },
    });

    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Session is not currently joinable");
    const msgs = mockApiLogger.warn.mock.calls.map((c) => c[1]);
    expect(msgs).toContain("zoom:join-denied:not-joinable-yet");
  });

  it("refuses a staff account from ANOTHER org outside the window", async () => {
    // isOrgStaff requires BOTH a staff role and a matching org, so a foreign
    // organizer falls through to the registration path and then the clock.
    mockAuth.mockResolvedValue({
      user: { id: "u-other", role: "ORGANIZER", organizationId: "org2", email: "x@y.com" },
    });
    mockDb.registration.findFirst.mockResolvedValue(null);

    const res = await call();
    expect(res.status).toBe(403);
  });

  it("still admits a registered attendee once the session is LIVE", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      ...sessionStartingTomorrow(),
      status: "LIVE",
    });
    mockAuth.mockResolvedValue({
      user: { id: "u-att2", role: "REGISTRANT", organizationId: null, email: "r2@x.com" },
    });
    mockDb.registration.findFirst.mockResolvedValue({
      id: "reg2",
      attendee: { firstName: "C", lastName: "D", email: "r2@x.com" },
    });

    const res = await call();
    expect(res.status).toBe(200);
  });
});

/**
 * Security review W-01 / W-02 (Nov 5, 2026), on a WEBINAR event: a registration that may watch,
 * and nothing that admits before the producer opens the room.
 */
describe("zoom-join on a webinar: entitlement and the waiting room", () => {
  const webinarEvent = {
    id: "ev1",
    organizationId: ORG,
    status: "PUBLISHED",
    eventType: "WEBINAR",
    settings: { webinar: { sessionId: "sess1" } },
  };
  /** The session lookup and the anchor (room) lookup both read eventSession; tell them apart. */
  function sessions(anchorStatus: string) {
    const start = new Date(Date.now() + 5 * 60_000); // inside the 15-minute window
    mockDb.eventSession.findFirst.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      args.select.zoomMeeting
        ? { ...sessionStartingTomorrow(), startTime: start, endTime: new Date(start.getTime() + 3600_000) }
        : { status: anchorStatus },
    );
  }
  const attendee = { id: "u-att", role: "REGISTRANT", organizationId: null, email: "a@x.com" };

  beforeEach(() => {
    mockDb.event.findFirst.mockResolvedValue(webinarEvent);
    mockAuth.mockResolvedValue({ user: attendee });
  });

  it("looks up only a registration that may watch: confirmed or checked in, paid or nothing owed", async () => {
    sessions("LIVE");
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B", email: "a@x.com" } });
    await call();
    const where = mockDb.registration.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["CONFIRMED", "CHECKED_IN"] });
    expect(where.OR[0]).toEqual({ paymentStatus: { in: ["PAID", "COMPLIMENTARY", "INCLUSIVE"] } });
  });

  it.each([
    ["PENDING", "PENDING_APPROVAL"],
    ["WAITLISTED", "WAITLISTED"],
    ["CONFIRMED", "PAYMENT_OUTSTANDING"],
  ])("a %s registration that may not watch is refused with %s, not 'register'", async (status, code) => {
    sessions("LIVE");
    mockDb.registration.findFirst.mockResolvedValue(null);
    mockDb.registration.findMany.mockResolvedValue([{ status }]);
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(code);
  });

  it("someone with no registration at all is still told to register", async () => {
    sessions("LIVE");
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await call();
    expect((await res.json()).code).toBe("NOT_REGISTERED");
  });

  it("before the room opens an attendee gets the waiting state: no signature, link, passcode or stream URL", async () => {
    sessions("SCHEDULED");
    mockSignature.mockResolvedValue({ sdkKey: "k", signature: "sig" });
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B", email: "a@x.com" } });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("waiting");
    for (const k of ["signature", "sdkKey", "passcode", "meetingNumber", "hlsPlaybackUrl", "hlsOriginUrl"]) {
      expect(body).not.toHaveProperty(k);
    }
    expect(body.joinUrl).toBe("");
  });

  it("once the room is open the attendee gets the join details", async () => {
    sessions("LIVE");
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B", email: "a@x.com" } });
    const body = await (await call()).json();
    expect(body.mode).toBe("url");
    expect(body.joinUrl).toBe("https://zoom.us/j/9999");
  });

  it("org staff preview a closed room", async () => {
    sessions("SCHEDULED");
    mockAuth.mockResolvedValue({ user: { id: "u-staff", role: "ORGANIZER", organizationId: ORG, email: "o@x.com" } });
    const body = await (await call()).json();
    expect(body.mode).toBe("url");
  });

  it("a DRAFT webinar opens on its own, as in lobby-status", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...webinarEvent, status: "DRAFT" });
    sessions("SCHEDULED");
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B", email: "a@x.com" } });
    expect((await (await call()).json()).mode).toBe("url");
  });
});

describe("zoom-join: a partner-produced webinar has no Zoom meeting and is watched as the stream alone (Nov 12, 2026)", () => {
  const KEY = "0123456789abcdef0123456789abcdef";
  const liveSession = (extra: Record<string, unknown> = {}) => ({
    id: "sess1",
    name: "Partner webinar",
    startTime: new Date(Date.now() - 600_000),
    endTime: new Date(Date.now() + 3600_000),
    status: "LIVE",
    zoomMeeting: null,
    externalStream: { streamKey: KEY, streamStatus: "ACTIVE" },
    ...extra,
  });
  const attendee = () => {
    mockAuth.mockResolvedValue({ user: { id: "u-att", role: "REGISTRANT", organizationId: null, email: "a@x.com" } });
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "Ada", lastName: "Lee", email: "a@x.com" } });
  };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com";
    delete process.env.HLS_CDN_BASE;
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      organizationId: ORG,
      status: "PUBLISHED",
      eventType: "WEBINAR",
      settings: { webinar: { sessionId: "sess1", source: "external", viewingMode: "hls" } },
    });
  });

  it("with the room open: the player's address and nothing of Zoom's, and no signature is ever asked for", async () => {
    attendee();
    mockDb.eventSession.findFirst.mockResolvedValue(liveSession());
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "stream",
      joinUrl: "",
      meetingType: "WEBINAR",
      liveStreamEnabled: true,
      hlsPlaybackUrl: `https://events.example.com/stream/live/${KEY}/index.m3u8`,
      userName: "Ada Lee",
    });
    expect(body).not.toHaveProperty("signature");
    expect(body).not.toHaveProperty("passcode");
    expect(body).not.toHaveProperty("streamKey");
    expect(mockSignature).not.toHaveBeenCalled();
  });

  it("with the room closed: the waiting answer, which says a stream exists but gives no address", async () => {
    attendee();
    // The anchor read (room check) and the session read both see a SCHEDULED session starting in ten minutes.
    mockDb.eventSession.findFirst.mockResolvedValue(
      liveSession({ status: "SCHEDULED", startTime: new Date(Date.now() + 600_000) }),
    );
    const body = await (await call()).json();
    expect(body).toMatchObject({ mode: "waiting", liveStreamEnabled: true, meetingType: "WEBINAR" });
    expect(body).not.toHaveProperty("hlsPlaybackUrl");
  });

  it("a session with neither a Zoom meeting nor a partner's stream still has nothing to join (404)", async () => {
    attendee();
    mockDb.eventSession.findFirst.mockResolvedValue(liveSession({ externalStream: null }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(expect.anything(), "zoom:join-no-meeting");
  });

  it("someone not registered is refused before anything about the stream is read", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-none", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    mockDb.eventSession.findFirst.mockResolvedValue(liveSession());
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_REGISTERED");
  });
});
