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

import { GET, POST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route";

const params = Promise.resolve({ eventId: "ev1", abstractId: "ab1" });
function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/sub", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "REVIEWER", organizationId: null } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { reviewerUserIds: ["u1"] }, reviewCriteria: [] });
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "UNDER_REVIEW" });
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

describe("abstract review — H3 cross-org admin bind", () => {
  it("rejects an ADMIN whose org differs from the event's org (no cross-org score injection)", async () => {
    // Org-B admin, not in the pool, no assignment → must NOT be treated as admin.
    mockAuth.mockResolvedValue({ user: { id: "adminB", role: "ADMIN", organizationId: "orgB" } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "orgA", settings: { reviewerUserIds: [] }, reviewCriteria: [] });
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ overallScore: 90 }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_REVIEWER");
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });

  it("allows a same-org ORGANIZER to submit", async () => {
    mockAuth.mockResolvedValue({ user: { id: "orgz", role: "ORGANIZER", organizationId: "org1" } });
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ overallScore: 90 }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("abstract review — H5 empty payload + H6 reviewable status", () => {
  beforeEach(() => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null); // pool reviewer
  });

  it("rejects a completely empty payload with 400 EMPTY_REVIEW (would mint an all-null row)", async () => {
    const res = await POST(makeReq({}), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_REVIEW");
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });

  it("allows a notes-only update (no score) — real flow, not empty", async () => {
    const res = await POST(makeReq({ reviewNotes: "looks good" }), { params });
    expect(res.status).toBeLessThan(400);
    expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledTimes(1);
  });

  it.each(["DRAFT", "WITHDRAWN", "ACCEPTED", "REJECTED"])(
    "refuses to score a %s abstract with 409 NOT_REVIEWABLE",
    async (status) => {
      mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status });
      const res = await POST(makeReq({ overallScore: 80 }), { params });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("NOT_REVIEWABLE");
      expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
    },
  );

  it.each(["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"])(
    "allows scoring a %s abstract",
    async (status) => {
      mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status });
      const res = await POST(makeReq({ overallScore: 80 }), { params });
      expect(res.status).toBeLessThan(400);
      expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledTimes(1);
    },
  );
});

// ── H9b (July 13, 2026): the submissions GET view matrix ─────────────────────
// The full per-reviewer view (identities + notes + per-criterion) is for org
// STAFF (ADMIN/SUPER_ADMIN/ORGANIZER) and pool reviewers only. MEMBER — a
// read-only, documented-as-sponsor-side role — used to receive it via the bare
// org-membership check, breaking blind review sideways. MEMBER (and the
// submitter) now get the anonymized shape.


describe("submissions GET — per-reviewer visibility (H9b)", () => {
  const getReq = new Request("http://localhost/sub");

  beforeEach(() => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "UNDER_REVIEW", speaker: { userId: "speaker-user" } });
    (mockDb as unknown as { abstractReviewSubmission: { findMany: ReturnType<typeof vi.fn> } }).abstractReviewSubmission.findMany = vi
      .fn()
      .mockResolvedValue([
        {
          id: "sub1", reviewerUserId: "rev1", overallScore: 80, reviewNotes: "Solid work",
          recommendedFormat: "ORAL", confidence: 4, criteriaScores: { c1: 8 },
          submittedAt: new Date(0), updatedAt: new Date(0),
          reviewer: { firstName: "Alice", lastName: "Chen" },
        },
      ]);
  });

  it("MEMBER gets the ANONYMIZED view — no reviewer identity, no per-criterion", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member1", role: "MEMBER", organizationId: "org1" } });
    const res = await GET(getReq, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Alice");
    expect(body.submissions[0].reviewerName).toBeUndefined();
    expect(body.submissions[0].reviewNotes).toBe("Solid work"); // feedback itself stays visible
    expect(body.aggregates.perCriterion).toBeUndefined();
  });

  it("org ADMIN keeps the full per-reviewer view", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", organizationId: "org1" } });
    const res = await GET(getReq, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("Alice");
  });

  it("pool REVIEWER keeps the full view; unrelated outsider still 403s", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "REVIEWER", organizationId: null } });
    const reviewerRes = await GET(getReq, { params });
    expect(reviewerRes.status).toBe(200);
    expect(JSON.stringify(await reviewerRes.json())).toContain("Alice");

    mockAuth.mockResolvedValue({ user: { id: "stranger", role: "REVIEWER", organizationId: null } });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { reviewerUserIds: ["u1"] }, reviewCriteria: [] });
    const strangerRes = await GET(getReq, { params });
    expect(strangerRes.status).toBe(403);
  });

  it("the abstract's submitter gets the anonymized view (unchanged contract)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "speaker-user", role: "SUBMITTER", organizationId: null } });
    const res = await GET(getReq, { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("Alice");
    expect(body.submissions[0].reviewNotes).toBe("Solid work");
  });
});
