/**
 * POST /api/events/[eventId]/emails/bulk now ENQUEUES a ScheduledEmail
 * (scheduledFor = now) and returns a job id (202) instead of sending
 * inline (2026-06-09 jobification). Pins: enqueue shape (recipientIds +
 * scheduledFor≈now persisted), the 202 + jobId envelope, and the
 * auth / denyReviewer / event-404 guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockCheckRateLimit, mockSafeParse, mockPrecheck, BulkEmailError } =
  vi.hoisted(() => {
    class BulkEmailError extends Error {
      status: number;
      code?: string;
      constructor(message: string, status = 400, code?: string) {
        super(message);
        this.status = status;
        this.code = code;
      }
    }
    return {
      mockAuth: vi.fn(),
      mockDb: {
        event: { findFirst: vi.fn() },
        scheduledEmail: { create: vi.fn(), findMany: vi.fn() },
        auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
      },
      mockCheckRateLimit: vi.fn(
        (): { allowed: boolean; retryAfterSeconds?: number } => ({ allowed: true }),
      ),
      mockSafeParse: vi.fn(),
      mockPrecheck: vi.fn(),
      BulkEmailError,
    };
  });

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
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));
vi.mock("@/lib/bulk-email", async (importOriginal) => {
  // The dedup guard is the REAL implementation (against the mocked db) so the
  // H2 value-matching tests below exercise the actual shared helper — the
  // same one the schedule POST uses since review C3.
  const actual = await importOriginal<typeof import("@/lib/bulk-email")>();
  return {
    bulkEmailSchema: { safeParse: mockSafeParse },
    precheckBulkEmailViability: mockPrecheck,
    findDuplicateQueuedSend: actual.findDuplicateQueuedSend,
    BulkEmailError,
  };
});

import { POST } from "@/app/api/events/[eventId]/emails/bulk/route";

function makeReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}
const params = Promise.resolve({ eventId: "ev_1" });

const validBody = {
  recipientType: "registrations",
  recipientIds: ["r1", "r2"],
  emailType: "custom",
  customSubject: "Hi",
  customMessage: "Body",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role: "ADMIN" } });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockSafeParse.mockReturnValue({ success: true, data: validBody });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev_1" });
  mockDb.scheduledEmail.create.mockResolvedValue({ id: "se_new", status: "PENDING" });
  mockPrecheck.mockResolvedValue({ event: { id: "ev_1" }, certTemplates: null, agreementMode: null });
  mockDb.scheduledEmail.findMany.mockResolvedValue([]);
});

describe("POST /emails/bulk — enqueue", () => {
  it("enqueues a ScheduledEmail with recipientIds + scheduledFor≈now and returns 202 + jobId", async () => {
    const before = Date.now();
    const res = await POST(makeReq(validBody), { params });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({ success: true, queued: true, jobId: "se_new", status: "PENDING" });

    expect(mockDb.scheduledEmail.create).toHaveBeenCalledTimes(1);
    const data = mockDb.scheduledEmail.create.mock.calls[0][0].data;
    expect(data.recipientIds).toEqual(["r1", "r2"]);
    expect(data.recipientType).toBe("registrations");
    expect(data.eventId).toBe("ev_1");
    expect(data.createdById).toBe("u1");
    const when = new Date(data.scheduledFor).getTime();
    expect(when).toBeGreaterThanOrEqual(before);
    expect(when).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("defaults recipientIds to [] when none selected (filter-based send)", async () => {
    mockSafeParse.mockReturnValue({ success: true, data: { ...validBody, recipientIds: undefined } });
    await POST(makeReq({}), { params });
    expect(mockDb.scheduledEmail.create.mock.calls[0][0].data.recipientIds).toEqual([]);
  });

  it("401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(401);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("403 for REVIEWER (denyReviewer)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", organizationId: "org_1", role: "REVIEWER" } });
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(403);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("429 when the bulk-email rate limit is exhausted", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(429);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("400 on schema validation failure", async () => {
    mockSafeParse.mockReturnValue({ success: false, error: { flatten: () => ({}) } });
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("404 when the event is not in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(404);
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  // ── M2: synchronous viability precheck ──
  it("rejects a misconfigured send synchronously (precheck) with no row created", async () => {
    mockPrecheck.mockRejectedValue(
      new BulkEmailError('Certificate template "X" has no tag', 400, undefined),
    );
    const res = await POST(makeReq(validBody), { params });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toContain("no tag");
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  // ── H2: enqueue idempotency (double-click / HTTP retry) ──
  it("dedups a same-content send-now — returns the existing jobId, no new row", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      // recipientIds intentionally in a different order — dedup sorts first.
      { id: "se_existing", customSubject: "Hi", customMessage: "Body", recipientIds: ["r2", "r1"], filters: null },
    ]);
    const res = await POST(makeReq(validBody), { params });
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ deduplicated: true, jobId: "se_existing" });
    expect(mockDb.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("does NOT dedup when content differs (different message) — enqueues a new row", async () => {
    mockDb.scheduledEmail.findMany.mockResolvedValue([
      { id: "se_other", customSubject: "Hi", customMessage: "DIFFERENT BODY", recipientIds: ["r1", "r2"], filters: null },
    ]);
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(202);
    expect(mockDb.scheduledEmail.create).toHaveBeenCalledTimes(1);
  });
});
