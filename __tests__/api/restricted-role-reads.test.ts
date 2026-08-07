/**
 * What a reviewer / submitter / registrant is allowed to READ.
 *
 * These roles are org-null and are legitimately served by shared endpoints, so
 * "the guard is on the route" is not enough: the route runs, and the question
 * is what it hands back. Two things were over-broad and are pinned here.
 *
 *  - GET /api/events/[eventId] returned the whole Event row, including the
 *    settings JSON (reviewer and onsite assignments, sponsors, the reusable
 *    survey token) and the internal auto-CC list.
 *
 *  - GET /api/events/[eventId]/speakers returned the ENTIRE faculty roster —
 *    every speaker's email, phone, bio and abstract titles — when the caller
 *    only ever needed their own row to bind as an author.
 *
 * Both assert on the QUERY, not on the rendering, because the fix is that the
 * data is never fetched. The shapes themselves are pinned in
 * __tests__/lib/event-visibility.test.ts; this file is the wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESTRICTED_EVENT_DETAIL_SELECT } from "@/lib/event-visibility";

const { mockAuth, mockDb, mockGetOrgContext } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetOrgContext: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: unknown) => fn }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/api-auth", () => ({ getOrgContext: () => mockGetOrgContext() }));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_user: unknown, eventId?: string) => ({ id: eventId }),
}));

describe("GET /api/events/[eventId] for an org-null role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the narrow shape and strips the settings blob", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "SUBMITTER", organizationId: null } });
    mockDb.event.findFirst.mockResolvedValue({
      id: "e1",
      name: "Cardio 2026",
      settings: { abstractPresentationTypes: ["ORAL"], reviewerUserIds: ["r1"] },
    });

    const { GET } = await import("@/app/api/events/[eventId]/route");
    const res = await GET(new Request("http://x/api/events/e1"), {
      params: Promise.resolve({ eventId: "e1" }),
    });
    const body = await res.json();

    // The narrow select was used, not an include of the whole row.
    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: RESTRICTED_EVENT_DETAIL_SELECT }),
    );
    expect(body.settings).toEqual({ abstractPresentationTypes: ["ORAL"] });
    expect(body.settings.reviewerUserIds).toBeUndefined();
    expect(body._count).toBeUndefined();
  });

  it("still 404s an event they are not linked to", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "REVIEWER", organizationId: null } });
    mockDb.event.findFirst.mockResolvedValue(null);

    const { GET } = await import("@/app/api/events/[eventId]/route");
    const res = await GET(new Request("http://x/api/events/e9"), {
      params: Promise.resolve({ eventId: "e9" }),
    });
    expect(res.status).toBe(404);
  });

  it("leaves staff on the full organiser payload", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "ORGANIZER", organizationId: "org1" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", name: "Cardio 2026", _count: {} });

    const { GET } = await import("@/app/api/events/[eventId]/route");
    await GET(new Request("http://x/api/events/e1"), {
      params: Promise.resolve({ eventId: "e1" }),
    });

    expect(mockDb.event.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ _count: expect.anything() }) }),
    );
  });
});

describe("GET /api/events/[eventId]/speakers for an org-null role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.event.findFirst.mockResolvedValue({ id: "e1", organizationId: "org1" });
    mockDb.speaker.findMany.mockResolvedValue([]);
  });

  const call = async () => {
    const { GET } = await import("@/app/api/events/[eventId]/speakers/route");
    return GET(new Request("http://x/api/events/e1/speakers"), {
      params: Promise.resolve({ eventId: "e1" }),
    });
  };

  it.each(["SUBMITTER", "REVIEWER", "REGISTRANT"])(
    "%s gets only their own speaker row",
    async (role) => {
      mockGetOrgContext.mockResolvedValue(null);
      mockAuth.mockResolvedValue({ user: { id: "u1", role, organizationId: null } });

      await call();

      expect(mockDb.speaker.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ eventId: "e1", userId: "u1" }),
        }),
      );
    },
  );

  it("staff still get the whole roster", async () => {
    mockGetOrgContext.mockResolvedValue(null);
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "ORGANIZER", organizationId: "org1" } });

    await call();

    const where = mockDb.speaker.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("userId");
  });

  it("an API key still gets the whole roster (org-scoped, admin-equivalent)", async () => {
    mockGetOrgContext.mockResolvedValue({ organizationId: "org1", role: null });
    mockAuth.mockResolvedValue(null);

    await call();

    const where = mockDb.speaker.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("userId");
  });
});
