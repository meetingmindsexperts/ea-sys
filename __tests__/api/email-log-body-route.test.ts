/**
 * GET /api/email-logs/[emailLogId]/body — org scoping with the null-org
 * fallback (Aug 3, 2026).
 *
 * Automated senders historically wrote org-NULL EmailLog rows; the list
 * surfaces showed them (entity/event-ownership scoped) but this route's
 * strict org match 404'd the "View" button ("Email not found"). A null-org
 * row is now readable IFF its event belongs to the caller's org; null-org
 * rows with no event (or a foreign event) stay hidden — fail closed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: { emailLog: { findFirst: vi.fn() } },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth-guards", () => ({
  WEBINAR_STAFF_ALLOW: ["WEBINARS"],
  REGISTRATION_DESK_ALLOW: ["ONSITE", "MEMBER", "WEBINARS"], denyReviewer: () => null }));

import { GET } from "@/app/api/email-logs/[emailLogId]/body/route";

const params = { params: Promise.resolve({ emailLogId: "log1" }) };
const req = new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
});

describe("GET email-log body", () => {
  it("the where accepts an org-matched row OR a null-org row whose event the caller owns", async () => {
    mockDb.emailLog.findFirst.mockResolvedValue({
      subject: "S", to: ["a@x.com"], createdAt: new Date(), htmlBody: "<p>hi</p>",
    });
    const res = await GET(req, params);
    expect(res.status).toBe(200);
    const where = mockDb.emailLog.findFirst.mock.calls[0][0].where as {
      id: string;
      OR: Array<Record<string, unknown>>;
    };
    expect(where.id).toBe("log1");
    expect(where.OR).toEqual([
      { organizationId: "org1" },
      // The null-org fallback is ownership-gated through the row's EVENT —
      // a null-org row with no event (or a foreign event) can never match.
      { organizationId: null, event: { organizationId: "org1" } },
    ]);
    expect((await res.json()).htmlBody).toBe("<p>hi</p>");
  });

  it("404s (logged) when no row matches the scoped where", async () => {
    mockDb.emailLog.findFirst.mockResolvedValue(null);
    const res = await GET(req, params);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Email not found");
  });

  it("404s NO_STORED_BODY when the row exists but carries no stored copy", async () => {
    mockDb.emailLog.findFirst.mockResolvedValue({
      subject: "S", to: ["a@x.com"], createdAt: new Date(), htmlBody: null,
    });
    const res = await GET(req, params);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NO_STORED_BODY");
  });

  it("403s an org-less caller before any query", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: null } });
    const res = await GET(req, params);
    expect(res.status).toBe(403);
    expect(mockDb.emailLog.findFirst).not.toHaveBeenCalled();
  });
});
