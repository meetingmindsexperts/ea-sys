/**
 * Event facts for external Help Assistant askers (Nov 2, 2026): which events
 * are read, what is shown for each role, and that a failure never blocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindMany, mockWarn } = vi.hoisted(() => ({ mockFindMany: vi.fn(), mockWarn: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { event: { findMany: mockFindMany } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn() } }));

import { loadExternalHelpEvents } from "@/lib/help-chat/event-facts";

const row = {
  name: "Gulf Heart\n Summit 2027",
  startDate: new Date("2027-03-12T05:00:00Z"),
  endDate: new Date("2027-03-14T05:00:00Z"),
  timezone: "Asia/Dubai",
  supportEmail: " heart@example.com ",
  settings: { abstractDeadline: "2099-12-01T19:59:00Z", abstractPresentationTypes: ["POSTER", "ORAL"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([row]);
});

describe("loadExternalHelpEvents", () => {
  it("formats a submitter's event with deadline and offered types, in the event's timezone", async () => {
    const [e] = await loadExternalHelpEvents({ id: "u1", role: "SUBMITTER" });
    expect(e).toEqual({
      name: "Gulf Heart Summit 2027",
      dates: "12 March 2027 to 14 March 2027",
      supportEmail: "heart@example.com",
      abstractDeadline: "1 December 2099 at 23:59 (Asia/Dubai)",
      presentationTypes: ["Oral Presentation", "Poster Presentation"],
    });
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ speakers: { some: { userId: "u1" } } });
    expect(where.AND).toContainEqual({ status: { not: "CANCELLED" } });
    expect(mockFindMany.mock.calls[0][0].take).toBe(5);
  });

  it("a deadline already behind us says so", async () => {
    mockFindMany.mockResolvedValue([{ ...row, settings: { abstractDeadline: "2020-09-29T11:59:00Z" } }]);
    const [e] = await loadExternalHelpEvents({ id: "u1", role: "SUBMITTER" });
    expect(e.abstractDeadline).toBe("29 September 2020 at 15:59 (Asia/Dubai, already passed)");
  });

  it("an attendee gets no abstract facts", async () => {
    const [e] = await loadExternalHelpEvents({ id: "u1", role: "REGISTRANT" });
    expect(e.abstractDeadline).toBeNull();
    expect(e.presentationTypes).toEqual([]);
    expect(mockFindMany.mock.calls[0][0].where.AND).toContainEqual({ registrations: { some: { userId: "u1" } } });
  });

  it("a reviewer's events include per-abstract assignments, not only the pool", async () => {
    await loadExternalHelpEvents({ id: "r1", role: "REVIEWER" });
    const scope = mockFindMany.mock.calls[0][0].where.AND[0];
    expect(scope.OR).toContainEqual({ settings: { path: ["reviewerUserIds"], array_contains: "r1" } });
    expect(scope.OR).toContainEqual({ abstracts: { some: { reviewers: { some: { userId: "r1" } } } } });
  });

  it("a blank support email and a missing deadline come back as null", async () => {
    mockFindMany.mockResolvedValue([{ ...row, supportEmail: "  ", settings: {} }]);
    const [e] = await loadExternalHelpEvents({ id: "u1", role: "SUBMITTER" });
    expect(e.supportEmail).toBeNull();
    expect(e.abstractDeadline).toBeNull();
    // No configured offering means every type is offered.
    expect(e.presentationTypes).toHaveLength(5);
  });

  it("a one-day event shows one date, and a bad timezone still shows it", async () => {
    mockFindMany.mockResolvedValue([{ ...row, endDate: row.startDate, timezone: "Not/AZone" }]);
    const [e] = await loadExternalHelpEvents({ id: "u1", role: "REGISTRANT" });
    expect(e.dates).toBe("12 March 2027");
  });

  it("a failed read returns no facts and logs, never throws", async () => {
    mockFindMany.mockRejectedValue(new Error("rls"));
    await expect(loadExternalHelpEvents({ id: "u1", role: "SUBMITTER" })).resolves.toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: "help-chat:event-facts-failed" }));
  });
});
