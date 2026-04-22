/**
 * Unit tests for src/services/abstract-service.ts — the Phase 2 extraction of
 * abstract status-change logic. Shared by the REST PUT review-status branch
 * and the MCP `update_abstract_status` tool. Mocks cover: DB, review-aggregate
 * helper, notification helper, event-stats refresh.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockDb,
  mockApiLogger,
  mockComputeAggregates,
  mockReadRequiredCount,
  mockConsolidateNotes,
  mockNotifyAbstract,
  mockRefreshStats,
} = vi.hoisted(() => {
  return {
    mockDb: {
      abstract: { findFirst: vi.fn(), update: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    mockComputeAggregates: vi.fn(),
    mockReadRequiredCount: vi.fn(),
    mockConsolidateNotes: vi.fn(),
    mockNotifyAbstract: vi.fn(),
    mockRefreshStats: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/abstract-review", () => ({
  computeSubmissionAggregates: mockComputeAggregates,
  readRequiredReviewCount: mockReadRequiredCount,
  consolidateReviewNotes: mockConsolidateNotes,
}));
vi.mock("@/lib/abstract-notifications", () => ({
  notifyAbstractStatusChange: mockNotifyAbstract,
}));
vi.mock("@/lib/event-stats", () => ({
  refreshEventStats: mockRefreshStats,
}));

import { changeAbstractStatus } from "@/services/abstract-service";

const BASE_INPUT = {
  eventId: "evt-1",
  organizationId: "org-1",
  userId: "user-1",
  abstractId: "abs-1",
  source: "rest" as const,
};

const ABSTRACT_FIXTURE = {
  id: "abs-1",
  title: "Cardiac imaging outcomes",
  status: "SUBMITTED",
  event: {
    id: "evt-1",
    name: "Test Conference",
    slug: "test-conf",
    settings: { requiredReviewCount: 1 },
  },
  speaker: {
    id: "spk-1",
    email: "speaker@example.com",
    firstName: "Sarah",
    lastName: "Mitchell",
  },
};

const SUFFICIENT_REVIEWS = {
  aggregates: { count: 2, meanOverall: 82, medianOverall: 82, minOverall: 75, maxOverall: 89, perCriterion: {} },
  submissions: [
    { id: "sub-1", reviewerUserId: "rev-1", reviewerName: "R1", overallScore: 75, reviewNotes: "Solid" },
    { id: "sub-2", reviewerUserId: "rev-2", reviewerName: "R2", overallScore: 89, reviewNotes: "Excellent" },
  ],
};
const ZERO_REVIEWS = {
  aggregates: { count: 0, meanOverall: null, medianOverall: null, minOverall: null, maxOverall: null, perCriterion: {} },
  submissions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.abstract.findFirst.mockResolvedValue(ABSTRACT_FIXTURE);
  mockDb.abstract.update.mockResolvedValue({
    id: "abs-1",
    title: ABSTRACT_FIXTURE.title,
    status: "ACCEPTED",
  });
  mockDb.auditLog.create.mockResolvedValue({});
  mockComputeAggregates.mockResolvedValue(SUFFICIENT_REVIEWS);
  mockReadRequiredCount.mockReturnValue(1);
  mockConsolidateNotes.mockReturnValue("Solid / Excellent");
  mockNotifyAbstract.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("changeAbstractStatus — happy path", () => {
  it("returns ok=true with updated abstract + aggregates on ACCEPTED transition", async () => {
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.abstract.status).toBe("ACCEPTED");
      expect(result.previousStatus).toBe("SUBMITTED");
      expect(result.reviewCount).toBe(2);
      expect(result.meanOverallScore).toBe(82);
      expect(result.forcedOverride).toBe(false);
      expect(result.notificationStatus).toBe("sent");
    }
  });

  it("sets reviewedAt when transitioning into a review status", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    const updateCall = mockDb.abstract.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("ACCEPTED");
    expect(updateCall.data.reviewedAt).toBeInstanceOf(Date);
  });

  it("does NOT set reviewedAt on WITHDRAWN transition (not a review status)", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "WITHDRAWN" });
    const updateCall = mockDb.abstract.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe("WITHDRAWN");
    expect(updateCall.data.reviewedAt).toBeUndefined();
  });

  it("writes audit log with action=UPDATE (not REVIEW) on WITHDRAWN transition", async () => {
    mockDb.abstract.update.mockResolvedValue({ id: "abs-1", title: ABSTRACT_FIXTURE.title, status: "WITHDRAWN" });
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "WITHDRAWN" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.action).toBe("UPDATE");
  });

  it("refreshes event stats on WITHDRAWN transition too (fire-and-forget)", async () => {
    mockDb.abstract.update.mockResolvedValue({ id: "abs-1", title: ABSTRACT_FIXTURE.title, status: "WITHDRAWN" });
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "WITHDRAWN" });
    expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
  });

  it("fires notifyAbstractStatusChange on review-status transition with consolidated notes", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(mockNotifyAbstract).toHaveBeenCalledTimes(1);
    const call = mockNotifyAbstract.mock.calls[0][0];
    expect(call).toMatchObject({
      eventId: "evt-1",
      eventName: "Test Conference",
      eventSlug: "test-conf",
      abstractId: "abs-1",
      abstractTitle: ABSTRACT_FIXTURE.title,
      previousStatus: "SUBMITTED",
      newStatus: "ACCEPTED",
      reviewNotes: "Solid / Excellent",
      reviewScore: 82,
      speaker: {
        id: "spk-1",
        email: "speaker@example.com",
        firstName: "Sarah",
        lastName: "Mitchell",
      },
    });
  });

  it("skips notification when newStatus === previousStatus (no-op transition)", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT_FIXTURE, status: "ACCEPTED" });
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notificationStatus).toBe("skipped");
    expect(mockNotifyAbstract).not.toHaveBeenCalled();
  });

  it("skips notification on WITHDRAWN transition (speaker initiated, no email needed)", async () => {
    mockDb.abstract.update.mockResolvedValue({ id: "abs-1", title: ABSTRACT_FIXTURE.title, status: "WITHDRAWN" });
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "WITHDRAWN" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notificationStatus).toBe("skipped");
    expect(mockNotifyAbstract).not.toHaveBeenCalled();
  });

  it("writes audit log with source=rest by default", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data).toMatchObject({
      eventId: "evt-1",
      userId: "user-1",
      action: "REVIEW",
      entityType: "Abstract",
      entityId: "abs-1",
      changes: expect.objectContaining({
        before: { status: "SUBMITTED" },
        after: { status: "ACCEPTED" },
        source: "rest",
      }),
    });
  });

  it("writes audit log with source=chair-override when forceStatus=true (takes precedence)", async () => {
    mockComputeAggregates.mockResolvedValue(ZERO_REVIEWS); // force past the gate
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED", forceStatus: true });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.source).toBe("chair-override");
  });

  it("includes requestIp in audit when passed (REST context)", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED", requestIp: "1.2.3.4" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.ip).toBe("1.2.3.4");
  });

  it("omits ip from audit when requestIp not provided (MCP context)", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED", source: "mcp" });
    const auditCall = mockDb.auditLog.create.mock.calls[0][0];
    expect(auditCall.data.changes.ip).toBeUndefined();
    expect(auditCall.data.changes.source).toBe("mcp");
  });

  it("refreshes event stats after update (fire-and-forget)", async () => {
    await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(mockRefreshStats).toHaveBeenCalledWith("evt-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards and domain errors
// ─────────────────────────────────────────────────────────────────────────────

describe("changeAbstractStatus — domain errors", () => {
  it("INVALID_STATUS when newStatus is outside the transition enum", async () => {
    const result = await changeAbstractStatus({
      ...BASE_INPUT,
      // @ts-expect-error — deliberately invalid for test
      newStatus: "DRAFT",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_STATUS");
    expect(mockDb.abstract.findFirst).not.toHaveBeenCalled();
  });

  it("ABSTRACT_NOT_FOUND when abstract lookup returns null (cross-org or missing)", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ABSTRACT_NOT_FOUND");
  });

  it("ABSTRACT_WITHDRAWN when current status is WITHDRAWN and transition is away from it", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT_FIXTURE, status: "WITHDRAWN" });
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ABSTRACT_WITHDRAWN");
      expect(result.meta).toEqual({ currentStatus: "WITHDRAWN" });
    }
    expect(mockDb.abstract.update).not.toHaveBeenCalled();
  });

  it("allows WITHDRAWN → WITHDRAWN no-op (idempotent)", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT_FIXTURE, status: "WITHDRAWN" });
    mockDb.abstract.update.mockResolvedValue({ id: "abs-1", title: ABSTRACT_FIXTURE.title, status: "WITHDRAWN" });
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "WITHDRAWN" });
    expect(result.ok).toBe(true);
  });

  it("INSUFFICIENT_REVIEWS blocks ACCEPTED when reviewer count < required (and forceStatus=false)", async () => {
    mockComputeAggregates.mockResolvedValue(ZERO_REVIEWS);
    mockReadRequiredCount.mockReturnValue(2);
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INSUFFICIENT_REVIEWS");
      expect(result.meta).toEqual({ currentCount: 0, required: 2 });
    }
    expect(mockDb.abstract.update).not.toHaveBeenCalled();
  });

  it("INSUFFICIENT_REVIEWS also blocks REJECTED transitions", async () => {
    mockComputeAggregates.mockResolvedValue(ZERO_REVIEWS);
    mockReadRequiredCount.mockReturnValue(1);
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "REJECTED" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INSUFFICIENT_REVIEWS");
  });

  it("forceStatus=true bypasses the review-count gate", async () => {
    mockComputeAggregates.mockResolvedValue(ZERO_REVIEWS);
    mockReadRequiredCount.mockReturnValue(2);
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED", forceStatus: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.forcedOverride).toBe(true);
    expect(mockDb.abstract.update).toHaveBeenCalled();
  });

  it("UNDER_REVIEW / REVISION_REQUESTED transitions are NOT gated on reviewer count", async () => {
    mockComputeAggregates.mockResolvedValue(ZERO_REVIEWS);
    mockReadRequiredCount.mockReturnValue(5);
    const r1 = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "UNDER_REVIEW" });
    expect(r1.ok).toBe(true);
    const r2 = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "REVISION_REQUESTED" });
    expect(r2.ok).toBe(true);
  });

  it("UNKNOWN when db.abstract.update throws unexpectedly", async () => {
    mockDb.abstract.update.mockRejectedValue(new Error("Connection refused"));
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "UNDER_REVIEW" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toContain("Connection refused");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notification failure isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("changeAbstractStatus — notification failure isolation", () => {
  it("returns ok=true with notificationStatus=failed when email send throws (DB write succeeded)", async () => {
    mockNotifyAbstract.mockRejectedValue(new Error("Brevo API down"));
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notificationStatus).toBe("failed");
      expect(result.notificationError).toContain("Brevo API down");
    }
    // DB update still committed
    expect(mockDb.abstract.update).toHaveBeenCalled();
  });

  it("audit-log failure is non-blocking (happy path still returns ok=true)", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("audit DB down"));
    const result = await changeAbstractStatus({ ...BASE_INPUT, newStatus: "ACCEPTED" });
    expect(result.ok).toBe(true);
  });
});
