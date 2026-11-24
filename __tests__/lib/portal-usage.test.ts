/** Who uses the attendee portal (Nov 24, 2026): src/lib/portal-usage.ts. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { user: { findMany: vi.fn() }, loginEvent: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { getPortalUsage, weekStartUtc, PORTAL_WEEKS } from "@/lib/portal-usage";

// Wednesday Nov 25, 2026, noon UTC.
const NOW = new Date("2026-11-25T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.loginEvent.findMany.mockResolvedValue([]);
});

describe("weekStartUtc", () => {
  it("is the Monday of the week, Sunday included in the week before", () => {
    expect(weekStartUtc(NOW).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(weekStartUtc(new Date("2026-11-23T00:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-23");
    expect(weekStartUtc(new Date("2026-11-22T23:59:00Z")).toISOString().slice(0, 10)).toBe("2026-11-16");
  });
});

const user = (id: string, lastSeenAt: Date | null, links: { reg?: boolean; author?: boolean; assigned?: boolean } = {}) => ({
  id,
  lastSeenAt,
  registrations: links.reg ? [{ id: "r" }] : [],
  speakers: links.author ? [{ id: "s" }] : [],
  abstractReviewerOf: links.assigned ? [{ id: "a" }] : [],
});

describe("getPortalUsage", () => {
  it("finds the active portal accounts linked to these events, never staff, and reads sign-ins through the same filter", async () => {
    mockDb.user.findMany.mockResolvedValue([]);
    await getPortalUsage([{ id: "ev1", settings: { reviewerUserIds: ["r1", 5] } }, { id: "ev2", settings: null }], NOW);
    const where = mockDb.user.findMany.mock.calls[0][0].where;
    const inScope = { in: ["ev1", "ev2"] };
    expect(where.role).toEqual({ in: ["REGISTRANT", "SUBMITTER", "REVIEWER"] });
    expect(where.deactivatedAt).toBeNull();
    expect(where.OR).toEqual([
      { registrations: { some: { eventId: inScope } } },
      { speakers: { some: { eventId: inScope, abstracts: { some: {} } } } },
      { abstractReviewerOf: { some: { abstract: { eventId: inScope } } } },
      { id: { in: ["r1"] } },
    ]);
    const signIns = mockDb.loginEvent.findMany.mock.calls[0][0].where;
    expect(signIns.user).toEqual(where);
    expect(signIns).not.toHaveProperty("userId");
  });

  it("no events, no query and nothing counted", async () => {
    const r = await getPortalUsage([], NOW);
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(r.totals.accounts).toBe(0);
    expect(r.weekly).toHaveLength(PORTAL_WEEKS);
  });

  it("rows are by link to these events, so one person can be in two; totals count each once (review of 85a9b8ce3)", async () => {
    mockDb.user.findMany.mockResolvedValue([
      user("a", ago(0.5), { reg: true }),
      user("b", ago(5), { reg: true, author: true }),
      user("c", null, { reg: true }),
      user("d", ago(20), { author: true, assigned: true }),
      user("e", ago(60)),
    ]);
    const r = await getPortalUsage([{ id: "ev1", settings: { reviewerUserIds: ["e"] } }], NOW);
    const row = (link: string) => r.links.find((x) => x.link === link);
    expect(row("REGISTERED")).toEqual({ link: "REGISTERED", accounts: 3, activeToday: 1, active7d: 2, active30d: 2, everActive: 2 });
    expect(row("AUTHOR")).toMatchObject({ accounts: 2, active7d: 1, active30d: 2 });
    expect(row("REVIEWER")).toMatchObject({ accounts: 2, active30d: 1, everActive: 2 });
    expect(r.totals).toEqual({ accounts: 5, activeToday: 1, active7d: 2, active30d: 3, everActive: 4 });
  });

  it("buckets successful sign-ins into Monday weeks, people counted once a week", async () => {
    mockDb.user.findMany.mockResolvedValue([user("a", ago(0), { reg: true }), user("b", ago(0), { author: true })]);
    mockDb.loginEvent.findMany.mockResolvedValue([
      { userId: "a", createdAt: new Date("2026-11-24T08:00:00Z") },
      { userId: "a", createdAt: new Date("2026-11-25T08:00:00Z") },
      { userId: "b", createdAt: new Date("2026-11-23T01:00:00Z") },
      { userId: "a", createdAt: new Date("2026-11-20T08:00:00Z") },
    ]);
    const r = await getPortalUsage([{ id: "ev1", settings: {} }], NOW);
    const where = mockDb.loginEvent.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ outcome: "SUCCESS" });
    expect(where.createdAt.gte.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(r.weekly.at(-1)).toEqual({ weekStart: "2026-11-23", people: 2, signIns: 3 });
    expect(r.weekly.at(-2)).toEqual({ weekStart: "2026-11-16", people: 1, signIns: 1 });
    expect(r.weekly[0].weekStart).toBe("2026-10-05");
  });
});
