/**
 * abstract-service.assignReviewersBulk / unassignReviewersBulk (Nov 12, 2026):
 * the bulk reviewer assignment behind the Abstracts page's tick boxes, Select
 * by IDs and the pasted reviewer sheet.
 *
 * What these pin: the bulk path keeps the single assign's rules (both ask
 * reviewerAssignmentRefusal), only the reviewer pool can be bulk assigned,
 * running it twice changes nothing, no email is sent, and bulk remove never
 * takes an assignment with a submitted review.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger, mockNotify } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    abstractReviewer: { findMany: vi.fn(), createManyAndReturn: vi.fn(), deleteMany: vi.fn() },
    abstractReviewSubmission: { findMany: vi.fn() },
    auditLog: { createMany: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ sendReviewerInvitation: mockNotify }));
vi.mock("@/lib/abstract-review", () => ({
  computeSubmissionAggregates: vi.fn(),
  computeWeightedOverallScore: vi.fn(),
  consolidateReviewNotes: vi.fn(),
  readRequiredReviewCount: vi.fn(),
}));
vi.mock("@/lib/abstract-notifications", () => ({ notifyAbstractStatusChange: vi.fn() }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));

import {
  assignReviewersBulk,
  unassignReviewersBulk,
  reviewerAssignmentRefusal,
  MAX_BULK_REVIEWER_PAIRS,
} from "@/services/abstract-service";

const BASE = { eventId: "ev1", organizationId: "org1", actorUserId: "admin1", source: "rest" as const };

const ABSTRACTS = [
  { id: "ab1", status: "SUBMITTED", speaker: { userId: "author1", email: "author1@x.test" } },
  { id: "ab2", status: "UNDER_REVIEW", speaker: { userId: null, email: "REV1@x.test" } }, // rev1's own, by address
  { id: "ab3", status: "WITHDRAWN", speaker: { userId: "author3", email: "author3@x.test" } },
  { id: "ab4", status: "DRAFT", speaker: { userId: "author4", email: "author4@x.test" } },
  { id: "ab5", status: "REVISION_REQUESTED", speaker: { userId: "rev2", email: "other@x.test" } }, // rev2's own, by account
];
const USERS = [
  { id: "rev1", email: "rev1@x.test" },
  { id: "rev2", email: "rev2@x.test" },
  { id: "outsider", email: "outsider@x.test" },
];

/** createManyAndReturn answers with a row per pair it was given, like Postgres with no conflicts. */
function writeEveryRow() {
  mockDb.abstractReviewer.createManyAndReturn.mockImplementation(async ({ data }: { data: { abstractId: string; userId: string }[] }) =>
    data.map((row) => ({ id: `ar-${row.abstractId}-${row.userId}`, abstractId: row.abstractId, userId: row.userId })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["rev1", "rev2"] } });
  mockDb.abstract.findMany.mockResolvedValue(ABSTRACTS);
  mockDb.user.findMany.mockResolvedValue(USERS);
  mockDb.abstractReviewer.findMany.mockResolvedValue([]);
  mockDb.abstractReviewSubmission.findMany.mockResolvedValue([]);
  mockDb.abstractReviewer.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.auditLog.createMany.mockResolvedValue({ count: 0 });
  writeEveryRow();
});

describe("reviewerAssignmentRefusal (the one rule, single and bulk)", () => {
  const rev = { id: "rev1", email: "rev1@x.test" };
  it("an abstract that is not up for review takes nobody, assigned already or not", () => {
    expect(reviewerAssignmentRefusal({ status: "WITHDRAWN" }, rev, false)).toBe("NOT_REVIEWABLE");
    expect(reviewerAssignmentRefusal({ status: "ACCEPTED" }, rev, true)).toBe("NOT_REVIEWABLE");
  });
  it("nobody is NEWLY given their own abstract; an existing row is left to be edited", () => {
    const own = { status: "SUBMITTED", speaker: { userId: "rev1", email: "a@b.c" } };
    expect(reviewerAssignmentRefusal(own, rev, false)).toBe("OWN_ABSTRACT");
    expect(reviewerAssignmentRefusal(own, rev, true)).toBeNull();
  });
  it("anything else is allowed", () => {
    expect(reviewerAssignmentRefusal({ status: "SUBMITTED", speaker: { userId: "x", email: "x@y.z" } }, rev, false)).toBeNull();
  });
});

describe("assignReviewersBulk", () => {
  it("puts every chosen reviewer on every chosen abstract, default role, stamped with the org and the actor", async () => {
    const r = await assignReviewersBulk({
      ...BASE,
      groups: [
        { reviewerUserId: "rev1", abstractIds: ["ab1"] },
        { reviewerUserId: "rev2", abstractIds: ["ab1", "ab2"] },
      ],
    });
    expect(r).toEqual({ ok: true, assigned: 3, alreadyAssigned: 0, skipped: [] });
    const { data, skipDuplicates } = mockDb.abstractReviewer.createManyAndReturn.mock.calls[0][0];
    expect(skipDuplicates).toBe(true);
    expect(data).toEqual([
      { abstractId: "ab1", organizationId: "org1", userId: "rev1", assignedById: "admin1" },
      { abstractId: "ab1", organizationId: "org1", userId: "rev2", assignedById: "admin1" },
      { abstractId: "ab2", organizationId: "org1", userId: "rev2", assignedById: "admin1" },
    ]);
    // No role or conflict flag is written: the schema's defaults apply, as with single assign.
    expect(Object.keys(data[0])).not.toContain("role");
  });

  it("sends no email", async () => {
    await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("skips, with the reason, what the single assign would refuse: own abstract, draft, withdrawn", async () => {
    const r = await assignReviewersBulk({
      ...BASE,
      groups: [
        { reviewerUserId: "rev1", abstractIds: ["ab1", "ab2", "ab3", "ab4"] },
        { reviewerUserId: "rev2", abstractIds: ["ab5"] },
      ],
    });
    expect(r).toMatchObject({ ok: true, assigned: 1, alreadyAssigned: 0 });
    expect(r.ok && r.skipped).toEqual([
      { abstractId: "ab2", reviewerUserId: "rev1", reason: "OWN_ABSTRACT" },
      { abstractId: "ab3", reviewerUserId: "rev1", reason: "NOT_REVIEWABLE" },
      { abstractId: "ab4", reviewerUserId: "rev1", reason: "NOT_REVIEWABLE" },
      { abstractId: "ab5", reviewerUserId: "rev2", reason: "OWN_ABSTRACT" },
    ]);
    expect(mockDb.abstractReviewer.createManyAndReturn.mock.calls[0][0].data).toHaveLength(1);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "abstract-reviewer:bulk-assign-skipped", byReason: { OWN_ABSTRACT: 2, NOT_REVIEWABLE: 2 } }),
    );
  });

  it("only the reviewer pool can be bulk assigned: an account off the pool, or no account, gets nothing", async () => {
    const r = await assignReviewersBulk({
      ...BASE,
      groups: [
        { reviewerUserId: "outsider", abstractIds: ["ab1"] },
        { reviewerUserId: "ghost", abstractIds: ["ab1"] },
      ],
    });
    expect(r).toMatchObject({ ok: true, assigned: 0 });
    expect(r.ok && r.skipped.map((s) => s.reason)).toEqual(["NOT_ON_POOL", "NOT_ON_POOL"]);
    expect(mockDb.abstractReviewer.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("an abstract that is not on this event is skipped, and the lookup is bound to the event", async () => {
    const r = await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1", "elsewhere"] }] });
    expect(r.ok && r.skipped).toEqual([{ abstractId: "elsewhere", reviewerUserId: "rev1", reason: "ABSTRACT_NOT_FOUND" }]);
    expect(mockDb.abstract.findMany.mock.calls[0][0].where).toMatchObject({ eventId: "ev1" });
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toEqual({ id: "ev1", organizationId: "org1" });
  });

  it("running it twice changes nothing: what is assigned already is counted and left alone", async () => {
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ abstractId: "ab1", userId: "rev1" }]);
    const r = await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] });
    expect(r).toEqual({ ok: true, assigned: 0, alreadyAssigned: 1, skipped: [] });
    expect(mockDb.abstractReviewer.createManyAndReturn).not.toHaveBeenCalled();
    expect(mockDb.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("a pair somebody else assigned in the meantime counts as already assigned, not as new", async () => {
    mockDb.abstractReviewer.createManyAndReturn.mockResolvedValue([{ id: "ar1", abstractId: "ab1", userId: "rev1" }]);
    const r = await assignReviewersBulk({
      ...BASE,
      groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }, { reviewerUserId: "rev2", abstractIds: ["ab1"] }],
    });
    expect(r).toMatchObject({ ok: true, assigned: 1, alreadyAssigned: 1 });
  });

  it("a pair named twice (two sheet rows) is one assignment", async () => {
    const r = await assignReviewersBulk({
      ...BASE,
      groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1", "ab1"] }, { reviewerUserId: "rev1", abstractIds: ["ab1"] }],
    });
    expect(r).toMatchObject({ ok: true, assigned: 1 });
  });

  it("audits one row per new assignment, in the single assign's shape, marked bulk", async () => {
    await assignReviewersBulk({ ...BASE, ip: "1.2.3.4", groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] });
    expect(mockDb.auditLog.createMany.mock.calls[0][0].data).toEqual([
      {
        eventId: "ev1",
        userId: "admin1",
        organizationId: "org1",
        action: "ASSIGN",
        entityType: "AbstractReviewer",
        entityId: "ar-ab1-rev1",
        changes: { source: "rest", bulk: true, abstractId: "ab1", reviewerUserId: "rev1", ip: "1.2.3.4" },
      },
    ]);
  });

  it("a failed audit write does not undo or fail the assignment (logged)", async () => {
    mockDb.auditLog.createMany.mockRejectedValue(new Error("audit down"));
    const r = await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] });
    expect(r).toMatchObject({ ok: true, assigned: 1 });
    expect(mockApiLogger.error).toHaveBeenCalled();
  });

  it("writes in chunks, so a large committee stays under the statement's parameter ceiling", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `ab-${i}`);
    mockDb.abstract.findMany.mockResolvedValue(ids.map((id) => ({ id, status: "SUBMITTED", speaker: { userId: "a", email: "a@x.test" } })));
    const r = await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ids }] });
    expect(r).toMatchObject({ ok: true, assigned: 1200 });
    expect(mockDb.abstractReviewer.createManyAndReturn.mock.calls.map((c) => c[0].data.length)).toEqual([500, 500, 200]);
  });

  it("refuses nothing-to-do, too many, and an event outside the organisation, each logged", async () => {
    expect(await assignReviewersBulk({ ...BASE, groups: [] })).toMatchObject({ ok: false, code: "NO_PAIRS" });
    const tooMany = Array.from({ length: MAX_BULK_REVIEWER_PAIRS + 1 }, (_, i) => `ab-${i}`);
    expect(await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: tooMany }] })).toMatchObject({ ok: false, code: "TOO_MANY" });
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();

    mockDb.event.findFirst.mockResolvedValue(null);
    expect(await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] })).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
    expect(mockApiLogger.warn).toHaveBeenCalledTimes(3);
    expect(mockDb.abstractReviewer.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("UNKNOWN on an unexpected failure: logged, a static message, never thrown", async () => {
    mockDb.abstractReviewer.createManyAndReturn.mockRejectedValue(new Error("boom"));
    const r = await assignReviewersBulk({ ...BASE, groups: [{ reviewerUserId: "rev1", abstractIds: ["ab1"] }] });
    expect(r).toEqual({ ok: false, code: "UNKNOWN", message: "Failed to assign reviewers" });
    expect(mockApiLogger.error).toHaveBeenCalled();
  });
});

describe("unassignReviewersBulk", () => {
  const ROWS = [
    { id: "ar1", abstractId: "ab1", userId: "rev1" },
    { id: "ar2", abstractId: "ab2", userId: "rev1" },
  ];
  const GROUPS = [{ reviewerUserId: "rev1", abstractIds: ["ab1", "ab2", "ab3"] }];

  beforeEach(() => {
    // First call: the assignments named. Second (inside the transaction): what survived the delete.
    mockDb.abstractReviewer.findMany.mockResolvedValueOnce(ROWS).mockResolvedValueOnce([]);
  });

  it("removes the assignments that exist and counts the pairs that were never assigned", async () => {
    const r = await unassignReviewersBulk({ ...BASE, groups: GROUPS });
    expect(r).toEqual({ ok: true, removed: 2, notAssigned: 1, skipped: [] });
    expect(mockDb.abstractReviewer.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["ar1", "ar2"] }, submissions: { none: {} } },
    });
    expect(mockDb.auditLog.createMany.mock.calls[0][0].data.map((d: { action: string; entityId: string }) => [d.action, d.entityId])).toEqual([
      ["UNASSIGN", "ar1"],
      ["UNASSIGN", "ar2"],
    ]);
  });

  it("never removes an assignment whose reviewer has submitted a review", async () => {
    mockDb.abstractReviewSubmission.findMany.mockResolvedValue([{ abstractId: "ab2", reviewerUserId: "rev1" }]);
    const r = await unassignReviewersBulk({ ...BASE, groups: GROUPS });
    expect(r).toEqual({
      ok: true,
      removed: 1,
      notAssigned: 1,
      skipped: [{ abstractId: "ab2", reviewerUserId: "rev1", reason: "HAS_REVIEW" }],
    });
    expect(mockDb.abstractReviewer.deleteMany.mock.calls[0][0].where.id).toEqual({ in: ["ar1"] });
  });

  it("a review that lands during the removal keeps its assignment, and the count and audit say so", async () => {
    mockDb.abstractReviewer.findMany.mockReset();
    mockDb.abstractReviewer.findMany.mockResolvedValueOnce(ROWS).mockResolvedValueOnce([{ id: "ar2" }]);
    const r = await unassignReviewersBulk({ ...BASE, groups: GROUPS });
    expect(r).toMatchObject({ ok: true, removed: 1, skipped: [{ abstractId: "ab2", reviewerUserId: "rev1", reason: "HAS_REVIEW" }] });
    expect(mockDb.auditLog.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it("nothing to remove writes nothing", async () => {
    mockDb.abstractReviewer.findMany.mockReset();
    mockDb.abstractReviewer.findMany.mockResolvedValue([]);
    const r = await unassignReviewersBulk({ ...BASE, groups: GROUPS });
    expect(r).toEqual({ ok: true, removed: 0, notAssigned: 3, skipped: [] });
    expect(mockDb.abstractReviewer.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.createMany).not.toHaveBeenCalled();
  });

  it("is bound to the event and the organisation", async () => {
    await unassignReviewersBulk({ ...BASE, groups: GROUPS });
    expect(mockDb.event.findFirst.mock.calls[0][0].where).toEqual({ id: "ev1", organizationId: "org1" });
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0].where).toMatchObject({ abstract: { eventId: "ev1" } });

    mockDb.event.findFirst.mockResolvedValue(null);
    mockDb.abstractReviewer.findMany.mockResolvedValue(ROWS);
    expect(await unassignReviewersBulk({ ...BASE, groups: GROUPS })).toMatchObject({ ok: false, code: "EVENT_NOT_FOUND" });
  });
});
