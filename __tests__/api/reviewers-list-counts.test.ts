/**
 * The Reviewers list (Nov 10, 2026): each reviewer's assigned and
 * not-emailed-yet counts, the people holding assignments off the pool, and a
 * response the browser never serves from its cache.
 *
 * The cache line was found in the browser: with stale-while-revalidate the
 * refetch after "Send assignments" was answered with the OLD list for up to 30
 * seconds, so the counts and buttons stayed wrong and invited a second press.
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

import { sendableAssignmentWhere } from "@/lib/abstract-reviewer-access";
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
  // Every assignment on the event, and (the sendable rule) the ones a press would email.
  mockDb.abstractReviewer.findMany.mockImplementation(({ where }: { where: { notifiedAt?: null } }) =>
    Promise.resolve(where.notifiedAt === null ? [{ userId: "r1" }] : [{ userId: "r1" }, { userId: "r1" }, { userId: "r2" }, { userId: "x9" }]),
  );
});

describe("GET reviewers", () => {
  it("is never served from the browser's cache", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("counts every assignment as assigned, and as not emailed only what a press would send", async () => {
    const body = await (await get()).json();
    const byId = Object.fromEntries(body.reviewers.map((r: { userId: string; assignments: unknown }) => [r.userId, r.assignments]));
    expect(byId).toEqual({ r1: { assigned: 2, unsent: 1 }, r2: { assigned: 1, unsent: 0 } });
    const sendable = mockDb.abstractReviewer.findMany.mock.calls.map(([a]) => a.where).find((w) => w.notifiedAt === null);
    expect(sendable).toEqual({ ...sendableAssignmentWhere("ev1"), userId: { in: ["r1", "r2"] } });
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
