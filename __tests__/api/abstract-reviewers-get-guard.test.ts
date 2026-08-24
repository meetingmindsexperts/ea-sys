/**
 * Blind-review gate on the per-abstract reviewer list (Aug 24, 2026).
 *
 * WHO reviewed an abstract, and what they scored it, is staff-only. Until this
 * fix the GET carried `requireOrgId` and no policy gate, which meant:
 *   - a SUBMITTER was refused, but only incidentally (they are org-null), and
 *   - a MEMBER was NOT refused at all — org-bound, so requireOrgId admits it,
 *     and buildEventAccessWhere gives MEMBER the whole org while the abstract
 *     lookup is not ownership-scoped.
 *
 * The MEMBER case is the load-bearing assertion: it fails if `denyReviewer` is
 * removed, where the SUBMITTER case would still pass on requireOrgId alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, warnSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    abstractReviewer: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: warnSpy, error: vi.fn() },
}));

import { GET } from "@/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route";

const params = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const req = () => new Request("http://localhost/x");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1" });
  mockDb.abstractReviewer.findMany.mockResolvedValue([]);
});

describe("GET abstract reviewers — staff-only", () => {
  it("refuses MEMBER (org-bound, so requireOrgId alone would let it through)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });

    const res = await GET(req(), params);

    expect(res.status).toBe(403);
    expect(mockDb.abstractReviewer.findMany).not.toHaveBeenCalled();
    // The refusal must be traceable, and must name the route it came from.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "auth-guard:write-denied",
        role: "MEMBER",
        route: "events/[eventId]/abstracts/[abstractId]/reviewers:GET",
      }),
    );
  });

  it.each(["SUBMITTER", "REVIEWER", "REGISTRANT", "ONSITE", "CRM_USER", "WEBINARS"])(
    "refuses %s",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: role === "ONSITE" ? "org1" : null } });

      const res = await GET(req(), params);

      expect(res.status).toBe(403);
      expect(mockDb.abstractReviewer.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN"])("admits %s", async (role) => {
    mockAuth.mockResolvedValue({ user: { id: "s1", role, organizationId: "org1" } });

    const res = await GET(req(), params);

    expect(res.status).toBe(200);
    expect(mockDb.abstractReviewer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { abstractId: "ab1" } }),
    );
  });

  it("refuses an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET(req(), params);

    expect(res.status).toBe(401);
    expect(mockDb.abstractReviewer.findMany).not.toHaveBeenCalled();
  });
});
