/**
 * abstract-service.submitAbstractReview — the ONE review-submission
 * implementation (review H7, July 13 2026). Previously triplicated across the
 * REST submissions POST and two MCP executors with live drift; these tests pin
 * the unified contract, especially the spots where the copies disagreed:
 *
 *  - H3 org-bind lives in the service (an org-B admin can't inject a score
 *    into org A's review) and the admin bypass is SELF-SUBMIT ONLY;
 *  - scores are integers everywhere (MCP used to accept floats);
 *  - reviewNotes: undefined keeps, "" clears (MCP used to silently keep);
 *  - an empty payload is rejected on every path (MCP used to upsert it);
 *  - notes >5000 chars are rejected (MCP used to silently truncate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    abstractReviewer: { findUnique: vi.fn() },
    abstractReviewSubmission: { upsert: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/abstract-notifications", () => ({ notifyAbstractStatusChange: vi.fn() }));

import { submitAbstractReview } from "@/services/abstract-service";

const EVENT = {
  id: "ev1",
  organizationId: "orgA",
  settings: { reviewerUserIds: ["pool-rev"] },
  reviewCriteria: [
    { id: "c1", weight: 60 },
    { id: "c2", weight: 40 },
  ],
};
const UPSERTED = {
  id: "sub1", overallScore: 80, reviewNotes: null, recommendedFormat: null,
  confidence: null, submittedAt: new Date(0), updatedAt: new Date(0), criteriaScores: null,
};

const base = {
  eventId: "ev1",
  abstractId: "ab1",
  source: "rest" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "UNDER_REVIEW" });
  mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
  mockDb.abstractReviewSubmission.upsert.mockResolvedValue(UPSERTED);
  mockDb.user.findUnique.mockResolvedValue({ id: "rev1", firstName: "A", lastName: "B", email: "a@b.c" });
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("authorization — the H3 org-bind lives in the service", () => {
  it("pool reviewer self-submits fine", async () => {
    const r = await submitAbstractReview({ ...base, reviewerUserId: "pool-rev", actor: { userId: "pool-rev" }, overallScore: 80 });
    expect(r.ok).toBe(true);
  });

  it("org-bound ADMIN self-submits WITHOUT pool/assignment (REST parity preserved)", async () => {
    const r = await submitAbstractReview({
      ...base,
      reviewerUserId: "admin1",
      actor: { userId: "admin1", role: "ADMIN", organizationId: "orgA" },
      overallScore: 80,
    });
    expect(r.ok).toBe(true);
  });

  it("an ADMIN of a DIFFERENT org is refused (H3 — no cross-org score injection)", async () => {
    const r = await submitAbstractReview({
      ...base,
      reviewerUserId: "adminB",
      actor: { userId: "adminB", role: "ADMIN", organizationId: "orgB" },
      overallScore: 90,
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_A_REVIEWER" });
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });

  it("the admin bypass is SELF-SUBMIT ONLY — on-behalf target must be pool/assigned", async () => {
    // Org-bound admin records for a target who is neither pool nor assigned.
    const r = await submitAbstractReview({
      ...base,
      reviewerUserId: "rev1",
      actor: { userId: "admin1", role: "ADMIN", organizationId: "orgA" },
      overallScore: 80,
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_A_REVIEWER" });
  });

  it("an actor with no role (MCP context) gets no admin bypass", async () => {
    const r = await submitAbstractReview({ ...base, reviewerUserId: "u1", actor: { userId: "u1" }, overallScore: 80 });
    expect(r).toMatchObject({ ok: false, code: "NOT_A_REVIEWER" });
  });
});

describe("on-behalf path", () => {
  it("records for a pool-reviewer target, returns their identity, audits on-behalf source", async () => {
    const r = await submitAbstractReview({
      ...base,
      source: "mcp",
      reviewerUserId: "pool-rev",
      actor: { userId: "admin1" },
      overallScore: 75,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.onBehalf).toBe(true);
      expect(r.reviewer).toMatchObject({ email: "a@b.c" });
    }
    // Upsert row belongs to the TARGET, audit userId is the ACTOR.
    expect(mockDb.abstractReviewSubmission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { abstractId_reviewerUserId: { abstractId: "ab1", reviewerUserId: "pool-rev" } } }),
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "admin1",
          changes: expect.objectContaining({ source: "mcp-on-behalf-of", reviewerUserId: "pool-rev" }),
        }),
      }),
    );
  });

  it("USER_NOT_FOUND when the target reviewer doesn't exist", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    const r = await submitAbstractReview({
      ...base, source: "mcp", reviewerUserId: "ghost", actor: { userId: "admin1" }, overallScore: 75,
    });
    expect(r).toMatchObject({ ok: false, code: "USER_NOT_FOUND" });
  });

  it("COI blocks the on-behalf path too — a conflicted review must never be recorded", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1", conflictFlag: true });
    const r = await submitAbstractReview({
      ...base, source: "mcp", reviewerUserId: "rev1", actor: { userId: "admin1" }, overallScore: 75,
    });
    expect(r).toMatchObject({ ok: false, code: "CONFLICT_OF_INTEREST" });
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });
});

describe("gates", () => {
  it("NOT_REVIEWABLE for a decided abstract", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", status: "ACCEPTED" });
    const r = await submitAbstractReview({ ...base, reviewerUserId: "pool-rev", actor: { userId: "pool-rev" }, overallScore: 80 });
    expect(r).toMatchObject({ ok: false, code: "NOT_REVIEWABLE" });
  });

  it("EMPTY_REVIEW on a payload with nothing in it — now enforced on EVERY path", async () => {
    const r = await submitAbstractReview({ ...base, source: "mcp", reviewerUserId: "pool-rev", actor: { userId: "pool-rev" } });
    expect(r).toMatchObject({ ok: false, code: "EMPTY_REVIEW" });
    expect(mockDb.abstractReviewSubmission.upsert).not.toHaveBeenCalled();
  });
});

describe("drift unification — REST semantics win", () => {
  const self = { reviewerUserId: "pool-rev", actor: { userId: "pool-rev" } };

  it("float overallScore is rejected (MCP used to accept it)", async () => {
    const r = await submitAbstractReview({ ...base, ...self, overallScore: 79.5 });
    expect(r).toMatchObject({ ok: false, code: "INVALID_OVERALL_SCORE" });
  });

  it("float criterion score is rejected", async () => {
    const r = await submitAbstractReview({ ...base, ...self, criteriaScores: [{ criterionId: "c1", score: 7.5 }] });
    expect(r).toMatchObject({ ok: false, code: "INVALID_CRITERION_SCORE" });
  });

  it("unknown + duplicate criterion ids are rejected", async () => {
    expect(await submitAbstractReview({ ...base, ...self, criteriaScores: [{ criterionId: "nope", score: 7 }] }))
      .toMatchObject({ ok: false, code: "INVALID_CRITERION_ID" });
    expect(
      await submitAbstractReview({
        ...base, ...self,
        criteriaScores: [{ criterionId: "c1", score: 7 }, { criterionId: "c1", score: 8 }],
      }),
    ).toMatchObject({ ok: false, code: "DUPLICATE_CRITERION_ID" });
  });

  it("notes over 5000 chars are rejected (MCP used to silently truncate)", async () => {
    const r = await submitAbstractReview({ ...base, ...self, reviewNotes: "x".repeat(5001) });
    expect(r).toMatchObject({ ok: false, code: "INVALID_REVIEW_NOTES" });
  });

  it('reviewNotes: undefined keeps existing notes; "" clears them', async () => {
    await submitAbstractReview({ ...base, ...self, overallScore: 80 });
    let update = mockDb.abstractReviewSubmission.upsert.mock.calls[0][0].update;
    expect("reviewNotes" in update).toBe(false); // keep

    await submitAbstractReview({ ...base, ...self, overallScore: 80, reviewNotes: "" });
    update = mockDb.abstractReviewSubmission.upsert.mock.calls[1][0].update;
    expect(update.reviewNotes).toBeNull(); // clear
  });

  it("auto-computes the weighted overall from criteria when overallScore is omitted", async () => {
    await submitAbstractReview({
      ...base, ...self,
      criteriaScores: [
        { criterionId: "c1", score: 10 }, // weight 60
        { criterionId: "c2", score: 5 },  // weight 40
      ],
    });
    const create = mockDb.abstractReviewSubmission.upsert.mock.calls[0][0].create;
    // (10*60 + 5*40) / 100 = 8.0 of 10 → 80 of 100
    expect(create.overallScore).toBe(80);
  });
});
