/**
 * MCP assign_reviewer_to_abstract — conflictFlag contract (review H8, July 13 2026).
 *
 * The tool schema always advertised `conflictFlag` but the executor silently
 * dropped it: "assign Dr X, flag the conflict" returned success with NO flag —
 * and since June 26 the flag is an ENFORCEMENT input (a conflicted reviewer is
 * blocked from scoring), so the dropped flag let their score count. These pin
 * the REST-parity behavior: persisted on create, toggleable on the upsert,
 * no-op re-calls report the current flag.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockNotify } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
    abstractReviewer: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockNotify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/abstract-reviewer-notify", () => ({ notifyReviewerAssigned: mockNotify }));

import { ABSTRACT_EXECUTORS } from "@/lib/agent/tools/abstracts";

const assign = ABSTRACT_EXECUTORS.assign_reviewer_to_abstract;
const ctx = { eventId: "ev1", organizationId: "org1", userId: "admin1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  // The shared service (abstract-service.assignReviewer) org-binds the event.
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Event" });
  mockDb.abstract.findFirst.mockResolvedValue({
    id: "ab1", title: "T", status: "UNDER_REVIEW",
    event: { id: "ev1", name: "Event", settings: {} },
  });
  mockDb.user.findUnique.mockResolvedValue({ id: "rev1", firstName: "A", lastName: "B", email: "a@b.c" });
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} } as never);
});

describe("MCP assign_reviewer_to_abstract — conflictFlag (H8)", () => {
  it("persists conflictFlag: true on a fresh assignment", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    mockDb.abstractReviewer.create.mockResolvedValue({ id: "ar1", role: "SECONDARY", conflictFlag: true, assignedAt: new Date(0) });
    const res = (await assign({ abstractId: "ab1", userId: "rev1", conflictFlag: true }, ctx)) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(mockDb.abstractReviewer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ conflictFlag: true }) }),
    );
  });

  it("defaults conflictFlag to false when omitted", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    mockDb.abstractReviewer.create.mockResolvedValue({ id: "ar1", role: "SECONDARY", conflictFlag: false, assignedAt: new Date(0) });
    await assign({ abstractId: "ab1", userId: "rev1" }, ctx);
    expect(mockDb.abstractReviewer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ conflictFlag: false }) }),
    );
  });

  it("toggles COI on an existing assignment without unassign+reassign (REST parity)", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1", role: "SECONDARY", conflictFlag: false });
    mockDb.abstractReviewer.update.mockResolvedValue({ id: "ar1", role: "SECONDARY", conflictFlag: true, assignedAt: new Date(0) });
    const res = (await assign({ abstractId: "ab1", userId: "rev1", conflictFlag: true }, ctx)) as Record<string, unknown>;
    expect(res.updated).toBe(true);
    expect(mockDb.abstractReviewer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { conflictFlag: true } }),
    );
    // A COI-only toggle must not touch the role.
    const data = mockDb.abstractReviewer.update.mock.calls[0][0].data;
    expect(data.role).toBeUndefined();
  });

  it("same role + same flag → idempotent no-op reporting the current flag", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ id: "ar1", role: "SECONDARY", conflictFlag: true });
    const res = (await assign({ abstractId: "ab1", userId: "rev1", role: "SECONDARY", conflictFlag: true }, ctx)) as Record<string, unknown>;
    expect(res.alreadyAssigned).toBe(true);
    expect(res.conflictFlag).toBe(true);
    expect(mockDb.abstractReviewer.update).not.toHaveBeenCalled();
  });
});
