/**
 * POST /api/events/[eventId]/certificates/bulk-reissue — creates a `reissue`
 * run + one item per already-issued cert (optionally tag-filtered). Covers auth,
 * role guard, rate limit, event/template 404, in-progress 409, empty-cohort 422,
 * and the happy path (run + createMany).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    certificateTemplate: { findFirst: vi.fn() },
    certificateIssueRun: { findFirst: vi.fn(), create: vi.fn() },
    certificateIssueRunItem: { createMany: vi.fn() },
    issuedCertificate: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({ checkRateLimit: (a: unknown) => mockRateLimit(a) }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (s: { user?: { role?: string } } | null) =>
    ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"].includes(s?.user?.role ?? "")
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null,
}));

import { POST } from "@/app/api/events/[eventId]/certificates/bulk-reissue/route";

const admin = { user: { id: "u1", role: "ADMIN", organizationId: "org-1" } };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const req = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 3600 });
  mockDb.event.findFirst.mockResolvedValue({ id: "evt-1" });
  mockDb.certificateTemplate.findFirst.mockResolvedValue({ id: "tmpl-1", category: "ATTENDANCE" });
  mockDb.certificateIssueRun.findFirst.mockResolvedValue(null); // no active reissue
  mockDb.issuedCertificate.findMany.mockResolvedValue([
    { id: "c1", registrationId: "r1", speakerId: null, recipientSnapshot: { fullName: "Dr A" } },
    { id: "c2", registrationId: "r2", speakerId: null, recipientSnapshot: { fullName: "Dr B" } },
  ]);
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  mockDb.certificateIssueRun.create.mockResolvedValue({ id: "run-1" });
  mockDb.certificateIssueRunItem.createMany.mockResolvedValue({ count: 2 });
});

describe("POST bulk-reissue", () => {
  it("401 unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req({ templateId: "tmpl-1" }), params)).status).toBe(401);
  });

  it("403 for a restricted role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", role: "MEMBER", organizationId: "org-1" } });
    expect((await POST(req({ templateId: "tmpl-1" }), params)).status).toBe(403);
  });

  it("429 when rate-limited", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await POST(req({ templateId: "tmpl-1" }), params)).status).toBe(429);
  });

  it("404 when the template is not found", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(null);
    expect((await POST(req({ templateId: "nope" }), params)).status).toBe(404);
  });

  it("409 when a reissue for the template is already in progress", async () => {
    mockDb.certificateIssueRun.findFirst.mockResolvedValue({ id: "run-active" });
    const res = await POST(req({ templateId: "tmpl-1" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("REISSUE_IN_PROGRESS");
  });

  it("422 when no issued certs match", async () => {
    mockDb.issuedCertificate.findMany.mockResolvedValue([]);
    const res = await POST(req({ templateId: "tmpl-1" }), params);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("NO_CERTS");
    expect(mockDb.certificateIssueRun.create).not.toHaveBeenCalled();
  });

  it("happy path: creates a reissue run + one item per cert", async () => {
    const res = await POST(req({ templateId: "tmpl-1" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, runId: "run-1", totalCount: 2 });
    expect(mockDb.certificateIssueRun.create.mock.calls[0][0].data).toMatchObject({
      reissue: true,
      status: "PENDING",
      certificateTemplateId: "tmpl-1",
      totalCount: 2,
    });
    const items = mockDb.certificateIssueRunItem.createMany.mock.calls[0][0].data;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ runId: "run-1", registrationId: "r1", issuedCertificateId: "c1", recipientName: "Dr A" });
  });

  it("tag-filters the cohort (attendee tag for ATTENDANCE)", async () => {
    await POST(req({ templateId: "tmpl-1", tag: "survey-completed" }), params);
    const where = mockDb.issuedCertificate.findMany.mock.calls[0][0].where;
    expect(where.registration).toEqual({ attendee: { tags: { has: "survey-completed" } } });
  });
});
