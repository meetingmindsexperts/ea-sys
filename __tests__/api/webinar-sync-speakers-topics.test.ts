/**
 * "Import from Speakers" on a webinar adds the speakers of the webinar
 * session AND of its topics (owner, Oct 7, 2026: a webinar is one session
 * whose parts are topics), once each.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAdd, mockList } = vi.hoisted(() => ({
  mockDb: {
    sessionSpeaker: { findMany: vi.fn() },
    topicSpeaker: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAdd: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } }) }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/permissions/require-permission", () => ({ requirePermission: () => ({ ok: true, eventWhere: { id: "ev1" } }) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }), getClientIp: () => "1.1.1.1" }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/zoom", () => ({ addWebinarPanelists: mockAdd, listWebinarPanelists: mockList }));
vi.mock("@/lib/webinar-panelist-email", () => ({ sendPanelistInvite: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/api/events/[eventId]/webinar/panelists/route", () => ({
  resolveAnchorZoomMeeting: async () => ({
    ok: true,
    anchorSessionId: "anchor1",
    zoomMeetingId: "zm1",
    event: { organizationId: "org1" },
  }),
}));

import { POST } from "@/app/api/events/[eventId]/webinar/panelists/sync-speakers/route";

const sp = (id: string, email = `${id}@x.test`) => ({ speaker: { id, firstName: id, lastName: "S", email } });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
  mockList.mockResolvedValue([]);
  mockAdd.mockResolvedValue(undefined);
});

describe("sync speakers to panelists", () => {
  it("adds session and topic speakers, each once", async () => {
    mockDb.sessionSpeaker.findMany.mockResolvedValue([sp("chair"), sp("both")]);
    mockDb.topicSpeaker.findMany.mockResolvedValue([sp("talk1"), sp("both"), sp("talk2")]);
    const res = await POST(new Request("http://x"), { params: Promise.resolve({ eventId: "ev1" }) });
    expect(res.status).toBe(200);
    expect(mockDb.topicSpeaker.findMany.mock.calls[0][0].where).toEqual({ topic: { sessionId: "anchor1" } });
    const added = mockAdd.mock.calls[0][2].map((c: { email: string }) => c.email).sort();
    expect(added).toEqual(["both@x.test", "chair@x.test", "talk1@x.test", "talk2@x.test"]);
  });
});
