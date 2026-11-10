/**
 * The reviewer portal (Nov 9, 2026): the feed, its sidebar summary and the
 * review page's read. A SUBMITTER on a pool is the case production got wrong:
 * it was emailed the review and then refused it. Since Nov 10, 2026 the
 * assignment is the whole rule: the pool lists nothing by itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    abstract: { findFirst: vi.fn(), findMany: vi.fn() },
    abstractReviewer: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    abstractReviewSubmission: { findUnique: vi.fn(), findMany: vi.fn() },
    reviewCriterion: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));

import { excludeOwnAbstracts } from "@/lib/abstract-reviewer-access";
import { GET as feed } from "@/app/api/my-reviews/route";
import { GET as detail } from "@/app/api/my-reviews/[eventId]/[abstractId]/route";

const SUBMITTER = { user: { id: "u1", email: "me@example.com", role: "SUBMITTER", organizationId: null } };
const params = { params: Promise.resolve({ eventId: "ev1", abstractId: "ab1" }) };
const req = (q = "") => new Request(`http://x/api/my-reviews${q}`);

const EVENT = {
  id: "ev1", name: "Conf", startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17"),
  organizationId: "org1", settings: { reviewerUserIds: ["u1"] },
};
const ABSTRACT = {
  id: "ab1", serialId: 7, title: "T", content: "Body", status: "SUBMITTED", specialty: null, presentationType: null,
  coAuthors: [{ firstName: "Co", lastName: "Author", email: "co@example.com" }], submittedAt: new Date("2026-10-01"),
  track: null, theme: null, subTheme: null,
  speaker: { userId: "u9", email: "author@example.com", firstName: "A", lastName: "B", jobTitle: null, organization: null, country: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(SUBMITTER);
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.abstract.findFirst.mockResolvedValue(ABSTRACT);
  mockDb.abstract.findMany.mockResolvedValue([]);
  mockDb.abstractReviewer.findUnique.mockResolvedValue({ role: "PRIMARY", conflictFlag: false });
  mockDb.abstractReviewer.findFirst.mockResolvedValue(null);
  mockDb.abstractReviewer.findMany.mockResolvedValue([]);
  mockDb.abstractReviewSubmission.findUnique.mockResolvedValue(null);
  mockDb.abstractReviewSubmission.findMany.mockResolvedValue([]);
  mockDb.reviewCriterion.findMany.mockResolvedValue([]);
  mockDb.user.findUnique.mockResolvedValue({ role: "SUBMITTER", emailConfirmedAt: new Date() });
});

describe("GET /api/my-reviews?summary=1", () => {
  it("is true for an assignment, whatever the role, never counting their own; the pool alone is not", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1" });
    await expect((await feed(req("?summary=1"))).json()).resolves.toMatchObject({ hasReviewWork: false });
    mockDb.abstractReviewer.findFirst.mockResolvedValue({ id: "r1" });
    await expect((await feed(req("?summary=1"))).json()).resolves.toMatchObject({ hasReviewWork: true });
    expect(mockDb.abstractReviewer.findFirst.mock.calls[0][0].where.abstract).toHaveProperty("speaker");
  });

  it("says whether they have an abstract of their own, by account only", async () => {
    mockDb.abstract.findFirst.mockImplementation(async ({ where }: { where: { speaker?: { userId?: string } } }) => (where.speaker?.userId === "u1" ? { id: "mine" } : null));
    await expect((await feed(req("?summary=1"))).json()).resolves.toEqual({ hasReviewWork: false, hasAbstracts: true });
  });

  it("is false with neither, and refuses nobody signed in", async () => {
    mockDb.abstract.findFirst.mockResolvedValue(null);
    await expect((await feed(req("?summary=1"))).json()).resolves.toEqual({ hasReviewWork: false, hasAbstracts: false });
    mockAuth.mockResolvedValue(null);
    expect((await feed(req("?summary=1"))).status).toBe(401);
  });
});

describe("GET /api/my-reviews", () => {
  const row = (id: string) => ({
    id, serialId: 1, title: id, status: "SUBMITTED", submittedAt: new Date("2026-10-01"), eventId: "ev1",
    event: { id: "ev1", name: "Conf", slug: "c", startDate: new Date("2027-01-15"), endDate: new Date("2027-01-17") },
  });

  it("leaves the person's own abstracts out", async () => {
    await feed(req());
    const not = excludeOwnAbstracts({ id: "u1", email: "me@example.com" });
    expect(mockDb.abstractReviewer.findMany.mock.calls[0][0].where.abstract).toMatchObject(not);
  });

  it("lists only what was assigned, never the rest of the pool's event", async () => {
    mockDb.abstract.findMany.mockResolvedValue([row("pool1"), row("mine")]);
    mockDb.abstractReviewer.findMany.mockResolvedValue([{ abstractId: "mine", role: "SECONDARY", conflictFlag: false, abstract: row("mine") }]);
    const { rows } = await (await feed(req())).json();
    expect(rows.map((r: { abstractId: string }) => r.abstractId)).toEqual(["mine"]);
    expect(mockDb.abstract.findMany).not.toHaveBeenCalled();
  });
});

describe("an account that has not proven its address", () => {
  beforeEach(() => mockDb.user.findUnique.mockResolvedValue({ role: "SUBMITTER", emailConfirmedAt: null }));

  it("gets no rows from the feed and is told to confirm", async () => {
    const body = await (await feed(req())).json();
    expect(body).toEqual({ rows: [], total: 0, needsEmailConfirmation: true });
    expect(mockDb.abstractReviewer.findMany).not.toHaveBeenCalled();
  });

  it("cannot read an abstract", async () => {
    const res = await detail(req(), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EMAIL_NOT_CONFIRMED");
    expect(mockDb.abstract.findFirst).not.toHaveBeenCalled();
  });

  it("staff are not asked: they are invited and org-bound", async () => {
    mockDb.user.findUnique.mockResolvedValue({ role: "ORGANIZER", emailConfirmedAt: null });
    expect((await detail(req(), params)).status).toBe(200);
  });
});

describe("GET /api/my-reviews/[eventId]/[abstractId]", () => {
  it("opens for an assigned SUBMITTER, with no contact details and no other reviewer", async () => {
    const res = await detail(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canSubmit).toBe(true);
    expect(body.abstract.content).toBe("Body");
    expect(body.abstract.coAuthors).toEqual([{ firstName: "Co", lastName: "Author" }]);
    expect(JSON.stringify(body)).not.toContain("@example.com");
    expect(mockDb.abstractReviewSubmission.findUnique.mock.calls[0][0].where.abstractId_reviewerUserId.reviewerUserId).toBe("u1");
  });

  it("opens for someone assigned to this abstract alone", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: {} });
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ role: "PRIMARY", conflictFlag: false });
    const res = await detail(req(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).assignmentRole).toBe("PRIMARY");
  });

  it("is a 404 to anyone not assigned, the event's pool included, and to nobody signed in a 401", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue(null);
    expect((await detail(req(), params)).status).toBe(404); // on the pool (EVENT lists u1), not assigned
    mockDb.event.findFirst.mockResolvedValue({ ...EVENT, settings: {} });
    expect((await detail(req(), params)).status).toBe(404);
    mockAuth.mockResolvedValue(null);
    expect((await detail(req(), params)).status).toBe(401);
  });

  it("refuses the author, by account or by address", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT, speaker: { ...ABSTRACT.speaker, userId: "u1" } });
    expect((await detail(req(), params)).status).toBe(403);
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT, speaker: { ...ABSTRACT.speaker, userId: null, email: "ME@example.com" } });
    const res = await detail(req(), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("OWN_ABSTRACT");
  });

  it("shows a conflicted reviewer the title and not the content", async () => {
    mockDb.abstractReviewer.findUnique.mockResolvedValue({ role: "SECONDARY", conflictFlag: true });
    const body = await (await detail(req(), params)).json();
    expect(body.conflict).toBe(true);
    expect(body.abstract).toEqual({ id: "ab1", serialId: 7, title: "T" });
  });

  it("asks only for abstracts past draft and not withdrawn, and closes a decided one", async () => {
    await detail(req(), params);
    expect(mockDb.abstract.findFirst.mock.calls[0][0].where.status).toEqual({ notIn: ["DRAFT", "WITHDRAWN"] });
    mockDb.abstract.findFirst.mockResolvedValue({ ...ABSTRACT, status: "ACCEPTED" });
    expect((await (await detail(req(), params)).json()).canSubmit).toBe(false);
  });

  it("flags the reviewer's own review as stale when the abstract moved on", async () => {
    mockDb.abstractReviewSubmission.findUnique.mockResolvedValue({
      overallScore: 80, criteriaScores: null, reviewNotes: null, recommendedFormat: null, updatedAt: new Date("2026-09-01"),
    });
    expect((await (await detail(req(), params)).json()).submission.stale).toBe(true);
  });
});
