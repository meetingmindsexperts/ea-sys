/**
 * Assigned event staff (custom roles Phase 4, release 2): the
 * `EventStaffAssignment` table is the only store. The `settings.onsiteUserIds`
 * JSON it replaced is neither written nor read, so a leftover id there grants
 * nothing.
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

describe("event staff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches an event through its assignment row only", () => {
    expect(assignedToEventWhere("u1")).toEqual({ staffAssignments: { some: { userId: "u1" } } });
    expect(JSON.stringify(assignedToEventWhere("u1"))).not.toContain("onsiteUserIds");
  });

  it("assigns into the table, once, and leaves the settings JSON alone", async () => {
    await assignEventStaff({ eventId: "e1", organizationId: "o1", userId: "u1", assignedById: "a1" });
    expect(mockDb.eventStaffAssignment.upsert).toHaveBeenCalledWith({
      where: { eventId_userId: { eventId: "e1", userId: "u1" } },
      create: { eventId: "e1", organizationId: "o1", userId: "u1", assignedById: "a1" },
      update: {},
    });
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("unassigns from the table and leaves the settings JSON alone", async () => {
    await unassignEventStaff({ eventId: "e1", userId: "u1" });
    expect(mockDb.eventStaffAssignment.deleteMany).toHaveBeenCalledWith({ where: { eventId: "e1", userId: "u1" } });
    expect(mockUpdateEventSettings).not.toHaveBeenCalled();
  });

  it("lists the table's rows", async () => {
    mockDb.eventStaffAssignment.findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u3" }]);
    expect(await eventStaffUserIds("e1")).toEqual(["u1", "u3"]);
  });
});
