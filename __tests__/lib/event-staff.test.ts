/**
 * Assigned event staff (custom roles Phase 4): the filter reads either store
 * during the transition, and every write goes to both, so a deploy or a
 * rollback never strands an assignment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockUpdateEventSettings } = vi.hoisted(() => ({
  mockDb: {
    eventStaffAssignment: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
  },
  mockUpdateEventSettings: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/event-settings", () => ({ updateEventSettings: mockUpdateEventSettings }));

import { assignEventStaff, eventStaffUserIds, unassignEventStaff } from "@/lib/event-staff";
import { assignedToEventWhere } from "@/lib/event-staff-where";

/** Runs the settings patch the helper passed, against `cur`. */
const patched = (cur: Record<string, unknown>) => mockUpdateEventSettings.mock.calls.at(-1)![1](cur);

describe("event staff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches an event through its row or through the JSON it replaces", () => {
    expect(assignedToEventWhere("u1")).toEqual({
      OR: [{ staffAssignments: { some: { userId: "u1" } } }, { settings: { path: ["onsiteUserIds"], array_contains: "u1" } }],
    });
  });

  it("assigns into both stores, once", async () => {
    await assignEventStaff({ eventId: "e1", organizationId: "o1", userId: "u1", assignedById: "a1" });
    expect(mockDb.eventStaffAssignment.upsert).toHaveBeenCalledWith({
      where: { eventId_userId: { eventId: "e1", userId: "u1" } },
      create: { eventId: "e1", organizationId: "o1", userId: "u1", assignedById: "a1" },
      update: {},
    });
    expect(patched({ onsiteUserIds: ["u1", "u2"], x: 1 })).toEqual({ onsiteUserIds: ["u1", "u2"], x: 1 });
    expect(patched({})).toEqual({ onsiteUserIds: ["u1"] });
  });

  it("unassigns from both stores", async () => {
    await unassignEventStaff({ eventId: "e1", userId: "u1" });
    expect(mockDb.eventStaffAssignment.deleteMany).toHaveBeenCalledWith({ where: { eventId: "e1", userId: "u1" } });
    expect(patched({ onsiteUserIds: ["u1", "u2"] })).toEqual({ onsiteUserIds: ["u2"] });
  });

  it("lists the union of both stores", async () => {
    mockDb.eventStaffAssignment.findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u3" }]);
    expect(await eventStaffUserIds("e1", { onsiteUserIds: ["u1", "u2", 7] })).toEqual(["u1", "u3", "u2"]);
    expect(await eventStaffUserIds("e1", null)).toEqual(["u1", "u3"]);
  });
});
