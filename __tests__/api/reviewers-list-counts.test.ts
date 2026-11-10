/**
 * The Reviewers list (Nov 10, 2026): how many abstracts each reviewer holds,
 * the people holding assignments off the pool, and a response the browser
 * never serves from its cache.
 *
 * The cache line was found in the browser: with stale-while-revalidate the
 * refetch after a send was answered with the OLD list for up to 30 seconds, so
 * the counts and buttons stayed wrong and invited a second press.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    abstractReviewer: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: () => Promise.resolve({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1" } }),
}));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, eventWhere: { id: "ev1", organizationId: "org1" } }),
  isLinkedRole: () => true,
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { GET } from "@/app/api/events/[eventId]/reviewers/route";

const USERS = [
  { id: "r1", email: "one@x.com", firstName: "One", lastName: "R", emailVerified: new Date(), role: "REVIEWER", emailConfirmedAt: new Date() },
  { id: "r2", email: "two@x.com", firstName: "Two", lastName: "R", emailVerified: null, role: "REVIEWER", emailConfirmedAt: null },
  { id: "x9", email: "gone@x.com", firstName: "Gone", lastName: "Reviewer" },
];
const get = () => GET(new Request("http://x"), { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["r1", "r2"] } });
  mockDb.speaker.findMany.mockResolvedValue([]);
  mockDb.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
    Promise.resolve(USERS.filter((u) => where.id.in.includes(u.id))),
  );
  // Every assignment on the event.
  mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "r1" }, { userId: "r1" }, { userId: "r2" }, { userId: "x9" }]);
});

describe("GET reviewers", () => {
  it("is never served from the browser's cache", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("counts each reviewer's assignments, and nothing about emails: no email is tied to an assignment", async () => {
    const body = await (await get()).json();
    const byId = Object.fromEntries(body.reviewers.map((r: { userId: string; assignments: unknown }) => [r.userId, r.assignments]));
    expect(byId).toEqual({ r1: { assigned: 2 }, r2: { assigned: 1 } });
    expect(mockDb.abstractReviewer.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0].where).toEqual({ abstract: { eventId: "ev1" } });
  });

  it("a reviewer with a speaker record on the event carries its title; an account alone has none", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "s1", email: "one@x.com", title: "DR", firstName: "One", lastName: "R", organization: null, jobTitle: null, status: "CONFIRMED", userId: "r1" },
    ]);
    const body = await (await get()).json();
    const titles = Object.fromEntries(body.reviewers.map((r: { userId: string; title: string | null }) => [r.userId, r.title]));
    expect(titles).toEqual({ r1: "DR", r2: null });
    // The mock ignores `select`, so the column being asked for is pinned too.
    expect(mockDb.speaker.findMany.mock.calls[0][0].select.title).toBe(true);
  });

  it("an unlinked speaker record on the reviewer's address gives the title too, as the emails read it", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "s2", email: "TWO@x.com", title: "PROF", firstName: "Two", lastName: "R", organization: null, jobTitle: null, status: "CONFIRMED", userId: null },
    ]);
    const body = await (await get()).json();
    expect(body.reviewers.find((r: { userId: string }) => r.userId === "r2").title).toBe("PROF");
  });

  it("only an invited account that has not accepted is pending; a registrant on the pool can already sign in", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: { reviewerUserIds: ["r1", "r2", "g1"] } });
    mockDb.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve([...USERS, { id: "g1", email: "reg@x.com", firstName: "Reg", lastName: "Istrant", emailVerified: null, role: "REGISTRANT", emailConfirmedAt: new Date() }].filter((u) => where.id.in.includes(u.id))),
    );
    const body = await (await get()).json();
    const active = Object.fromEntries(body.reviewers.map((r: { userId: string; accountActive: boolean }) => [r.userId, r.accountActive]));
    expect(active).toEqual({ r1: true, r2: false, g1: true });
  });

  it("names the people holding assignments who are not on the pool", async () => {
    const body = await (await get()).json();
    expect(body.assignedOffPool).toEqual([{ userId: "x9", firstName: "Gone", lastName: "Reviewer", email: "gone@x.com", assigned: 1 }]);
    expect(body.reviewers.map((r: { userId: string }) => r.userId)).not.toContain("x9");
  });

  it("an empty pool still names off-pool assignees, and reads no reviewer accounts", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", settings: {} });
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ userId: "x9" }]);
    const body = await (await get()).json();
    expect(body.reviewers).toEqual([]);
    expect(body.assignedOffPool).toHaveLength(1);
  });
});
