/**
 * GET /api/events/[eventId]/submitter-context — feeds the submitter surface
 * separation. Pins: SUBMITTER-only (staff/other roles 403 — this is a
 * self-context endpoint, not a data API), own-speaker resolution via userId
 * (no ids accepted), and the response shape the sidebar/guard consume.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    // event.findUnique resolves the resource org before the (tenant-wrapped)
    // speaker read — the Session Proposals sweep (Aug 2026) added this.
    event: { findUnique: vi.fn() },
    speaker: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "@/app/api/events/[eventId]/submitter-context/route";

const routeParams = { params: Promise.resolve({ eventId: "ev1" }) };
const req = new Request("http://test/api/events/ev1/submitter-context");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "SUBMITTER" } });
  mockDb.event.findUnique.mockResolvedValue({ organizationId: "org1" });
  mockDb.speaker.findFirst.mockResolvedValue({
    submitterSource: "proposal",
    _count: { abstracts: 0, sessionProposals: 2 },
  });
});

describe("submitter-context route", () => {
  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req, routeParams)).status).toBe(401);
  });

  it.each(["ADMIN", "ORGANIZER", "REVIEWER", "REGISTRANT", "MEMBER"])(
    "403 for %s — submitters only",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role } });
      expect((await GET(req, routeParams)).status).toBe(403);
      expect(mockDb.speaker.findFirst).not.toHaveBeenCalled();
    },
  );

  it("resolves the speaker by the CALLER's userId (own-speaker by construction)", async () => {
    await GET(req, routeParams);
    expect(mockDb.speaker.findFirst.mock.calls[0][0].where).toEqual({
      eventId: "ev1",
      userId: "u1",
    });
  });

  it("404 when the submitter has no speaker on this event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect((await GET(req, routeParams)).status).toBe(404);
  });

  it("returns the surface context shape", async () => {
    const res = await GET(req, routeParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      submitterSource: "proposal",
      abstractCount: 0,
      proposalCount: 2,
    });
  });
});
