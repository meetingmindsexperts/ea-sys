/**
 * Webinar panelist GET gating (Aug 27, 2026). The event-level panelist GET
 * had no denyReviewer while the POST/DELETE did, so a read-only MEMBER / an
 * unassigned ONSITE / a CRM_USER could enumerate every panelist's join_url
 * (a Zoom present/share-screen/unmute bearer link) + name + email. This pins
 * the GET is now gated by WEBINAR_STAFF_ALLOW, exercising the REAL denyReviewer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockList } = vi.hoisted(() => ({
  mockDb: { event: { findFirst: vi.fn() }, zoomMeeting: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
  mockList: vi.fn(),
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
vi.mock("@/lib/event-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/event-access")>()),
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/webinar", () => ({
  readWebinarSettings: (s: unknown) => (s as { webinar?: unknown } | null)?.webinar ?? null,
}));
vi.mock("@/lib/zoom", () => ({
  addWebinarPanelists: vi.fn(), removeWebinarPanelist: vi.fn(),
  listWebinarPanelists: () => mockList(),
}));
vi.mock("@/lib/webinar-panelist-email", () => ({ sendPanelistInvite: vi.fn() }));
// @/lib/auth-guards is REAL — denyReviewer is what we're testing.

import { GET } from "@/app/api/events/[eventId]/webinar/panelists/route";

const req = () => new Request("http://localhost/x");
const params = { params: Promise.resolve({ eventId: "ev1" }) };
const user = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", organizationId: "org1", settings: { webinar: { sessionId: "s1" } },
  });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ zoomMeetingId: "123", meetingType: "WEBINAR" });
  mockList.mockResolvedValue([
    { id: "p1", name: "Dr X", email: "x@e.com", join_url: "https://zoom.us/w/PANELIST_LINK" },
  ]);
});

describe("panelist GET is gated by WEBINAR_STAFF_ALLOW", () => {
  it.each(["MEMBER", "ONSITE", "CRM_USER"])("403s %s (cannot enumerate join_url)", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN", "WEBINARS"])("allows %s to list panelists", async (role) => {
    mockAuth.mockResolvedValue(user(role));
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.panelists[0].join_url).toBe("https://zoom.us/w/PANELIST_LINK");
  });
});
