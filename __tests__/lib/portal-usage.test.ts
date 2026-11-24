/** Who uses the attendee portal (Nov 24, 2026): src/lib/portal-usage.ts. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { user: { findMany: vi.fn() }, loginEvent: { findMany: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { getPortalUsage, weekStartUtc, PORTAL_WEEKS } from "@/lib/portal-usage";

// Wednesday Nov 25, 2026, noon UTC.
const NOW = new Date("2026-11-25T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.loginEvent.findMany.mockResolvedValue([]);
  mockDb.loginEvent.findFirst.mockResolvedValue({ createdAt: new Date("2026-07-28T10:51:10Z") });
});

describe("weekStartUtc", () => {
  it("is the Monday of the week, Sunday included in the week before", () => {
    expect(weekStartUtc(NOW).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(weekStartUtc(new Date("2026-11-23T00:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(weekStartUtc(new Date("2026-11-22T23:59:00Z")).toISOString().slice(0, 10)).toBe("2026-11-16");
  });
});

describe("getPortalUsage", () => {
  it("finds the portal accounts linked to these events (registration, speaker, assignment, pool), never staff", async () => {
    mockDb.user.findMany.mockResolvedValue([]);
    await getPortalUsage([{ id: "ev1", settings: { reviewerUserIds: ["r1", 5] } }, { id: "ev2", settings: null }], NOW);
    const where = mockDb.user.findMany.mock.calls[0][0].where;
    expect(where.role).toEqual({ in: ["REGISTRANT", "SUBMITTER", "REVIEWER"] });
    expect(where.OR).toEqual([
      { registrations: { some: { eventId: { in: ["ev1", "ev2"] } } } },
      { speakers: { some: { eventId: { in: ["ev1", "ev2"] } } } },
      { abstractReviewerOf: { some: { abstract: { eventId: { in: ["ev1", "ev2"] } } } } },
      { id: { in: ["r1"] } },
    ]);
  });

  it("no events, no query and nothing counted", async () => {
    const r = await getPortalUsage([], NOW);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(r.totals.accounts).toBe(0);
    expect(r.weekly).toHaveLength(PORTAL_WEEKS);
  });

  it("counts accounts and activity per role and in total", async () => {
    mockDb.user.findMany.mockResolvedValue([
      { id: "a", role: "REGISTRANT", lastSeenAt: ago(0.5) },
      { id: "b", role: "REGISTRANT", lastSeenAt: ago(5) },
      { id: "c", role: "REGISTRANT", lastSeenAt: null },
      { id: "d", role: "SUBMITTER", lastSeenAt: ago(20) },
      { id: "e", role: "REVIEWER", lastSeenAt: ago(60) },
    ]);
    const r = await getPortalUsage([{ id: "ev1", settings: {} }], NOW);
    expect(r.roles.find((x) => x.role === "REGISTRANT")).toEqual({ role: "REGISTRANT", accounts: 3, activeToday: 1, active7d: 2, active30d: 2, everActive: 2 });
    expect(r.roles.find((x) => x.role === "SUBMITTER")).toMatchObject({ accounts: 1, active7d: 0, active30d: 1 });
    expect(r.roles.find((x) => x.role === "REVIEWER")).toMatchObject({ accounts: 1, active30d: 0, everActive: 1 });
    expect(r.totals).toEqual({ accounts: 5, activeToday: 1, active7d: 2, active30d: 3, everActive: 4 });
    expect(r.signInsRecordedFrom).toBe("2026-07-28T10:51:10.000Z");
  });

  it("buckets successful sign-ins into Monday weeks, people counted once a week", async () => {
    mockDb.user.findMany.mockResolvedValue([{ id: "a", role: "REGISTRANT", lastSeenAt: ago(0) }, { id: "b", role: "SUBMITTER", lastSeenAt: ago(0) }]);
    mockDb.loginEvent.findMany.mockResolvedValue([
      { userId: "a", createdAt: new Date("2026-11-24T08:00:00Z") },
      { userId: "a", createdAt: new Date("2026-11-25T08:00:00Z") },
      { userId: "b", createdAt: new Date("2026-11-23T01:00:00Z") },
      { userId: "a", createdAt: new Date("2026-11-20T08:00:00Z") },
    ]);
    const r = await getPortalUsage([{ id: "ev1", settings: {} }], NOW);
    const where = mockDb.loginEvent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ userId: { in: ["a", "b"] }, outcome: "SUCCESS" });
    expect(where.createdAt.gte.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(r.weekly.at(-1)).toEqual({ weekStart: "2026-11-23", people: 2, signIns: 3 });
    expect(r.weekly.at(-2)).toEqual({ weekStart: "2026-11-16", people: 1, signIns: 1 });
    expect(r.weekly[0].weekStart).toBe("2026-10-05");
  });
});
