/**
 * Conflict-of-interest enforcement on abstract review submission. A reviewer
 * flagged with a COI on an abstract must be blocked from scoring it — their
 * review must never count toward the decision. Previously conflictFlag was
 * advisory only (stored + badged, never enforced).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    abstractReviewer: { findUnique: vi.fn() },
    abstractReviewSubmission: { upsert: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));

import { POST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route";

const params = Promise.resolve({ eventId: "ev1", abstractId: "ab1" });
function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/sub", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "REVIEWER", organizationId: null } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { reviewerUserIds: ["u1"] }, reviewCriteria: [] });
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1" });
  const d = new Date(0);
  mockDb.abstractReviewSubmission.upsert.mockResolvedValue({
    id: "sub1", overallScore: 80, reviewNotes: null, recommendedFormat: null, confidence: null,
    submittedAt: d, updatedAt: d, criteriaScores: null,
  });
});

describe("abstract review — COI enforcement", () => {
  it("blocks a conflicted reviewer with 403 CONFLICT_OF_INTEREST and records no review", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1", conflictFlag: true });
    const res = await POST(makeReq({ overallScore: 80 }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CONFLICT_OF_INTEREST");
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });

  it("allows a non-conflicted assigned reviewer to submit", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1", conflictFlag: false });
    const res = await POST(makeReq({ overallScore: 80 }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledTimes(1);
  });

  it("allows a pool reviewer with no explicit assignment (no COI flag to carry)", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ overallScore: 80 }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledTimes(1);
  });
});
