/**
 * POST /api/events/[eventId]/emails/schedule — the create path.
 *
 * Pins the recipientIds-persistence fix: the route previously parsed
 * `recipientIds` but never wrote it, so every scheduled send silently fell back
 * to filter-based (a selected-row schedule over-sent to everyone matching the
 * filters). Now: a selection is persisted as a fixed list; omitting it stores
 * [] (filter-based = re-evaluated at fire time = late-inclusive). Uses the REAL
 * bulkEmailSchema (the route does `bulkEmailSchema.extend({ scheduledFor })`)
 * so validation is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockCheckRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    scheduledEmail: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockCheckRateLimit: vi.fn(
    (): { allowed: boolean; retryAfterSeconds?: number } => ({ allowed: true }),
  ),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => mockCheckRateLimit(),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/auth-guards", () => ({
  // Mirror the real guard's restricted set — MEMBER/ONSITE/CRM_USER must be
  // blocked too (the schedule GET now routes through denyReviewer per review
  // R1; a mock that omits them would let a regression slip past this suite).
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (
      role === "REVIEWER" ||
      role === "SUBMITTER" ||
      role === "REGISTRANT" ||
      role === "MEMBER" ||
      role === "ONSITE" ||
      role === "CRM_USER"
    ) {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));
// NOTE: bulk-email is intentionally NOT mocked — the route extends the real
// bulkEmailSchema, so we exercise real validation.

import { POST, GET } from "@/app/api/events/[eventId]/emails/schedule/route";

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}
const params = Promise.resolve({ eventId: "ev_1" });

const futureWhen = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

function validBody(over: Record<string, unknown> = {}) {
  return {
    recipientType: "registrations",
    recipientIds: ["r1", "r2"],
    emailType: "custom",
    customSubject: "Hi",
    customMessage: "Body",
    scheduledFor: futureWhen(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role: "ADMIN" } });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev_1" });
  mockDb.scheduledEmail.create.mockResolvedValue({ id: "se_new", status: "PENDING" });
  // Default: no dedup candidate (C3 guard finds nothing).
  mockDb.scheduledEmail.findMany.mockResolvedValue([]);
  mockDb.scheduledEmail.findUnique.mockResolvedValue(null);
});

describe("POST /emails/schedule — create", () => {
  it("persists the selected recipientIds (fixed list)", async () => {
    const res = await POST(makeReq(validBody()), { params });
    const body = await res.json();
    expect(body).toMatchObject({ success: true });
    expect(mockDb.scheduledEmail.create).toHaveBeenCalledTimes(1);
    const data = mockDb.scheduledEmail.create.mock.calls[0][0].data;
    expect(data.recipientIds).toEqual(["r1", "r2"]);
    expect(data.recipientType).toBe("registrations");
    expect(data.eventId).toBe("ev_1");
    expect(data.createdById).toBe("u1");
  });

  it("defaults recipientIds to [] when none selected (filter-based = late-inclusive)", async () => {
    const res = await POST(makeReq(validBody({ recipientIds: undefined })), { params });
    expect(res.status).toBe(200);
    expect(mockDb.scheduledEmail.create.mock.calls[0][0].data.recipientIds).toEqual([]);
  });

  it("400 when scheduledFor is less than the 5-minute lead time", async () => {
    const res = await POST(
      makeReq(validBody({ scheduledFor: new Date(Date.now() + 60 * 1000).toISOString() })),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("403 for REVIEWER (denyReviewer)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role: "REVIEWER" } });
    const res = await POST(makeReq(validBody()), { params });
    expect(res.status).toBe(403);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("404 when the event is not in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody()), { params });
    expect(res.status).toBe(404);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  // C3 (July 16, 2026): the send-now route got the H2 dedup guard; this door
  // didn't — a 502'd/double-clicked schedule POST created two identical
  // PENDING rows that BOTH fired at the scheduled time.
  it("dedups an identical schedule POST — returns the existing row, no new row", async () => {
    const when = futureWhen();
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      {
        id: "se_existing",
        customSubject: "Hi",
        customMessage: "Body",
        // Different order on purpose — the guard sorts before comparing.
        recipientIds: ["r2", "r1"],
        filters: null,
      },
    ]);
    mockDb.scheduledEmail.findUnique.mockResolvedValue({ id: "se_existing", status: "PENDING" });

    const res = await POST(makeReq(validBody({ scheduledFor: when })), { params });
    const body = await res.json();
    expect(body).toMatchObject({ success: true, deduplicated: true });
    expect(body.scheduledEmail.id).toBe("se_existing");
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
    // The candidate query is scoped to the IDENTICAL scheduledFor — two
    // deliberate sends at different times must never collide.
    const where = mockDb.scheduledEmail.findMany.mock.calls[0][0].where;
    expect(where.scheduledFor).toEqual({ equals: new Date(when) });
  });

  it("does NOT dedup when content differs — enqueues a new row", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { id: "se_other", customSubject: "Different", customMessage: "Body", recipientIds: ["r1", "r2"], filters: null },
    ]);
    const res = await POST(makeReq(validBody()), { params });
    expect((await res.json()).success).toBe(true);
    expect(mockDb.scheduledEmail.create).toHaveBeenCalledTimes(1);
  });
});

describe("GET /emails/schedule — list (review R1, July 16 2026)", () => {
  // This was the ONE comms read with no role guard: org-bound restricted
  // roles (CRM_USER — walled off from every event surface; ONSITE desk
  // temps; read-only MEMBER) could pull every scheduled campaign's subject,
  // body and filters for any event in their org.
  const getReq = () => ({} as unknown as Request);

  it.each(["CRM_USER", "ONSITE", "MEMBER", "REVIEWER", "REGISTRANT"])(
    "403s %s before any DB read",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role } });
      const res = await GET(getReq(), { params });
      expect(res.status).toBe(403);
      expect(mockDb.scheduledEmail.findMany).not.toHaveBeenCalled();
    },
  );

  it("allows ADMIN and returns the list", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([]);
    const res = await GET(getReq(), { params });
    expect(res.status).toBe(200);
    expect(mockDb.scheduledEmail.findMany).toHaveBeenCalledTimes(1);
  });
});
