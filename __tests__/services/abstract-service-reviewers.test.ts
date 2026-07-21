/**
 * Unit tests for abstract-service.assignReviewer / unassignReviewer — the
 * duplication-audit finding-3 extraction. The REST reviewers routes + MCP
 * assign/unassign tools used to carry ~130 mirrored lines that drifted twice
 * (H6 status gate, H8 dropped conflictFlag); the service is now the one
 * implementation, so these pin the shared behavior once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockNotify } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    abstractReviewer: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerAssigned: mockNotify }));
vi.mock("@/lib/abstract-review", () => ({
  computeSubmissionAggregates: vi.fn(),
  computeWeightedOverallScore: vi.fn(),
  consolidateReviewNotes: vi.fn(),
  readRequiredReviewCount: vi.fn(),
}));
vi.mock("@/lib/abstract-notifications", () => ({ notifyAbstractStatusChange: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import { assignReviewer, unassignReviewer } from "@/services/abstract-service";

const REVIEWER = { id: "rev1", firstName: "A", lastName: "B", email: "a@b.c" };
const BASE = {
  eventId: "ev1",
  organizationId: "org1",
  abstractId: "ab1",
  reviewerUserId: "rev1",
  actorUserId: "admin1",
  source: "rest" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Event" });
  mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status: "UNDER_REVIEW" });
  mockDb.user.findUnique.mockResolvedValue(REVIEWER);
  mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
  mockDb.abstractReviewer.create.mockResolvedValue({
    id: "ar1", role: "SECONDARY", conflictFlag: false, assignedAt: new Date(0),
  });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.abstractReviewer.delete.mockResolvedValue({});
});

describe("assignReviewer", () => {
  it("creates a new assignment (default SECONDARY, no COI), audits with source, notifies the reviewer", async () => {
    const r = await assignReviewer(BASE);
    expect(r).toMatchObject({ ok: true, kind: "created" });
    expect(mockDb.abstractReviewer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { abstractId: "ab1", userId: "rev1", assignedById: "admin1", role: "SECONDARY", conflictFlag: false },
      }),
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "ASSIGN",
        entityType: "AbstractReviewer",
        changes: expect.objectContaining({ source: "rest", reviewerUserId: "rev1" }),
      }),
    });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ reviewer: REVIEWER, abstractTitle: "T", source: "rest" }),
    );
  });

  it("persists conflictFlag on create (the H8 class can't recur — one implementation)", async () => {
    await assignReviewer({ ...BASE, conflictFlag: true, role: "PRIMARY" });
    expect(mockDb.abstractReviewer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "PRIMARY", conflictFlag: true }) }),
    );
  });

  it("noop when re-assigned with the same role + flag — no write, no notification", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({
      id: "ar1", role: "SECONDARY", conflictFlag: false, assignedAt: new Date(0),
    });
    const r = await assignReviewer({ ...BASE, role: "SECONDARY" });
    expect(r).toMatchObject({ ok: true, kind: "noop", assignment: { id: "ar1", role: "SECONDARY" } });
    expect(mockDb.abstractReviewer.update).not.toHaveBeenCalled();
    expect(mockDb.abstractReviewer.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("upserts a role/COI change WITHOUT re-notifying, audits before/after values", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({
      id: "ar1", role: "SECONDARY", conflictFlag: false, assignedAt: new Date(0),
    });
    mockDb.abstractReviewer.update.mockResolvedValue({
      id: "ar1", role: "PRIMARY", conflictFlag: false, assignedAt: new Date(0),
    });
    const r = await assignReviewer({ ...BASE, role: "PRIMARY" });
    expect(r).toMatchObject({ ok: true, kind: "updated", assignment: { role: "PRIMARY" } });
    // A role-only change must not touch the flag.
    expect(mockDb.abstractReviewer.update.mock.calls[0][0].data).toEqual({ role: "PRIMARY" });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UPDATE",
        changes: expect.objectContaining({ previousRole: "SECONDARY", previousConflictFlag: false }),
      }),
    });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("NOT_REVIEWABLE for a decided/draft/withdrawn abstract (H6 gate)", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status: "ACCEPTED" });
    const r = await assignReviewer(BASE);
    expect(r).toMatchObject({ ok: false, code: "NOT_REVIEWABLE" });
    expect(mockDb.abstractReviewer.create).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalled();
  });

  it("EVENT_NOT_FOUND / ABSTRACT_NOT_FOUND / USER_NOT_FOUND, each logged", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect(await assignReviewer(BASE)).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Event" });
    mockDb.abstract.findFirst.mockResolvedValue(null);
    expect(await assignReviewer(BASE)).toMatchObject({ ok: false, code: "ABSTRACT_NOT_FOUND" });
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1", title: "T", status: "SUBMITTED" });
    mockDb.user.findUnique.mockResolvedValue(null);
    expect(await assignReviewer(BASE)).toMatchObject({ ok: false, code: "USER_NOT_FOUND" });
    expect(mockApiLogger.warn).toHaveBeenCalledTimes(3);
  });

  it("UNKNOWN on an unexpected DB failure (logged, never thrown)", async () => {
    mockDb.abstractReviewer.create.mockRejectedValue(new Error("boom"));
    const r = await assignReviewer(BASE);
    expect(r).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(mockApiLogger.error).toHaveBeenCalled();
  });
});

describe("unassignReviewer", () => {
  beforeEach(() => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1" });
  });

  it("deletes the assignment row + audits (submission preserved via SET NULL FK)", async () => {
    const r = await unassignReviewer(BASE);
    expect(r).toEqual({ ok: true, unassignedAssignmentId: "ar1" });
    expect(mockDb.abstractReviewer.delete).toHaveBeenCalledWith({ where: { id: "ar1" } });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UNASSIGN",
        entityId: "ar1",
        changes: expect.objectContaining({ source: "rest", reviewerUserId: "rev1" }),
      }),
    });
  });

  it("ASSIGNMENT_NOT_FOUND when there's nothing to remove", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    const r = await unassignReviewer(BASE);
    expect(r).toMatchObject({ ok: false, code: "ASSIGNMENT_NOT_FOUND" });
    expect(mockDb.abstractReviewer.delete).not.toHaveBeenCalled();
  });

  it("EVENT_NOT_FOUND when the event isn't in the caller's org", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const r = await unassignReviewer(BASE);
    expect(r).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
    expect(mockDb.abstractReviewer.delete).not.toHaveBeenCalled();
  });
});
