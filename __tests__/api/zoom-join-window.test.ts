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
    registration: { findFirst: vi.fn() },
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
