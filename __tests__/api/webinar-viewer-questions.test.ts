/**
 * Questions from custom-stream viewers (Oct 1, 2026): the public ask/list
 * route and the producer list/mark route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn() },
    webinarViewerQuestion: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    webinarQuestionVote: { groupBy: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "1.2.3.4",
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { POST as ask, GET as listMine } from "@/app/api/public/events/[slug]/sessions/[sessionId]/questions/route";
import { GET as listAll, PATCH as mark } from "@/app/api/events/[eventId]/webinar/questions/route";
import { POST as vote } from "@/app/api/public/events/[slug]/sessions/[sessionId]/questions/[questionId]/vote/route";
import { Prisma } from "@prisma/client";

const publicParams = { params: Promise.resolve({ slug: "test-webinar", sessionId: "s1" }) };
const staffParams = { params: Promise.resolve({ eventId: "ev1" }) };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null, firstName: "A", lastName: "B" } };
const organizer = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Org", lastName: "Staff" } };

const req = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "WEBINAR", settings: { webinar: { sessionId: "s1" } } });
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1" });
  mockDb.webinarViewerQuestion.create.mockResolvedValue({ id: "q1", question: "Why?", status: "NEW", createdAt: new Date() });
  for (const fn of Object.values(mockDb.webinarQuestionVote)) fn.mockReset();
  mockDb.webinarQuestionVote.groupBy.mockResolvedValue([]);
  mockDb.webinarQuestionVote.findMany.mockResolvedValue([]);
  mockDb.webinarQuestionVote.deleteMany.mockResolvedValue({ count: 0 });
  mockDb.webinarQuestionVote.create.mockResolvedValue({});
  mockDb.webinarQuestionVote.count.mockResolvedValue(1);
  mockDb.webinarViewerQuestion.findFirst.mockReset().mockResolvedValue({ id: "q2" });
});

describe("public: ask a question", () => {
  it("401 when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(401);
  });

  it("403 when not registered for the event", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(403);
    expect(mockDb.webinarViewerQuestion.create).not.toHaveBeenCalled();
  });

  it("400 for an empty or over-long question", async () => {
    mockAuth.mockResolvedValue(attendee);
    expect((await ask(req({ question: "  " }), publicParams)).status).toBe(400);
    expect((await ask(req({ question: "x".repeat(1001) }), publicParams)).status).toBe(400);
  });

  it("stores the question under the registration's name, never a name from the body", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "Dana", lastName: "Lee" } });
    const res = await ask(req({ question: "  What is the dose?  ", askerName: "Someone Else" }), publicParams);
    expect(res.status).toBe(201);
    expect(mockDb.webinarViewerQuestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "ev1", organizationId: "org1", sessionId: "s1", registrationId: "r1",
          askerName: "Dana Lee", question: "What is the dose?",
        }),
      }),
    );
  });

  it("org staff testing the page can ask without a registration", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await ask(req({ question: "Test question" }), publicParams);
    expect(res.status).toBe(201);
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
    expect(mockDb.webinarViewerQuestion.create.mock.calls[0][0].data).toMatchObject({ registrationId: null, askerName: "Org Staff" });
  });

  it("404 for a session that is not the webinar room, or a non-webinar event: questions there would reach nobody", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "ev1", organizationId: "org1", eventType: "WEBINAR", settings: { webinar: { sessionId: "other" } } });
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(404);
    mockDb.event.findFirst.mockResolvedValueOnce({ id: "ev1", organizationId: "org1", eventType: "CONFERENCE", settings: { webinar: { sessionId: "s1" } } });
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(404);
    expect(mockDb.webinarViewerQuestion.create).not.toHaveBeenCalled();
  });

  it("404 when the session is not in this event", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "D", lastName: "L" } });
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect((await ask(req({ question: "Hello there" }), publicParams)).status).toBe(404);
  });

  it("lists the viewer's own questions and the shown ones, with shortened names, never dismissed", async () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "D", lastName: "L" } });
    mockDb.webinarViewerQuestion.findMany
      .mockResolvedValueOnce([{ id: "q1", question: "Mine", status: "NEW", isPublic: false }])
      .mockResolvedValueOnce([{ id: "q2", question: "Shown", status: "ANSWERED", askerName: "Dana Maria Lee" }]);
    const res = await listMine(req(), publicParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[0][0].where).toMatchObject({ registrationId: "r1", sessionId: "s1" });
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[1][0].where).toEqual({
      sessionId: "s1", eventId: "ev1", isPublic: true, status: { not: "DISMISSED" },
    });
    expect(body.published).toEqual([
      { id: "q2", question: "Shown", status: "ANSWERED", askerName: "Dana L.", voteCount: 0, votedByMe: false },
    ]);
    expect(body).toMatchObject({ upvote: true, canVote: true });
  });
});

describe("producer: list and mark", () => {
  it("lists the anchor session's questions", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.findMany.mockResolvedValue([{ id: "q1" }, { id: "q2" }]);
    mockDb.webinarQuestionVote.groupBy.mockResolvedValue([{ questionId: "q2", _count: { _all: 3 } }]);
    const res = await listAll(req(), staffParams);
    expect(res.status).toBe(200);
    expect(mockDb.webinarViewerQuestion.findMany.mock.calls[0][0].where).toEqual({ eventId: "ev1", sessionId: "s1" });
    expect((await res.json()).questions).toEqual([{ id: "q1", voteCount: 0 }, { id: "q2", voteCount: 3 }]);
    expect(mockDb.webinarQuestionVote.groupBy.mock.calls[0][0].where).toEqual({ eventId: "ev1", questionId: { in: ["q1", "q2"] } });
  });

  it("marks a question answered, bound to the event", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 1 });
    const res = await mark(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ id: "q1", status: "ANSWERED" }) }),
      staffParams,
    );
    expect(res.status).toBe(200);
    const call = mockDb.webinarViewerQuestion.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "q1", eventId: "ev1" });
    expect(call.data.status).toBe("ANSWERED");
    expect(call.data.answeredAt).toBeInstanceOf(Date);
  });

  it("shows a question to attendees; dismissing always hides it; an empty change is refused", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 1 });
    const patch = (body: unknown) =>
      mark(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), staffParams);
    expect((await patch({ id: "q1", isPublic: true })).status).toBe(200);
    expect(mockDb.webinarViewerQuestion.updateMany.mock.calls[0][0].data).toEqual({ isPublic: true });
    expect((await patch({ id: "q1", status: "DISMISSED", isPublic: true })).status).toBe(200);
    expect(mockDb.webinarViewerQuestion.updateMany.mock.calls[1][0].data).toMatchObject({ status: "DISMISSED", isPublic: false });
    expect((await patch({ id: "q1" })).status).toBe(400);
  });

  it("404 for a question from another event; 400 for a bad status; 403 for a read-only member", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.webinarViewerQuestion.updateMany.mockResolvedValue({ count: 0 });
    const patch = (body: unknown) =>
      mark(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), staffParams);
    expect((await patch({ id: "qX", status: "ANSWERED" })).status).toBe(404);
    expect((await patch({ id: "q1", status: "DELETED" })).status).toBe(400);
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", organizationId: "org1" } });
    expect((await patch({ id: "q1", status: "ANSWERED" })).status).toBe(403);
  });
});

describe("public: upvote a shown question (Oct 6, 2026)", () => {
  const voteParams = { params: Promise.resolve({ slug: "test-webinar", sessionId: "s1", questionId: "q2" }) };
  const post = () => vote(new Request("http://localhost/x", { method: "POST" }), voteParams);
  const asAttendee = () => {
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "D", lastName: "L" } });
  };

  it("401 when signed out", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
  });

  it("records one vote for the registration, stamped with the event's org", async () => {
    asAttendee();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ voted: true, voteCount: 1 });
    expect(mockDb.webinarQuestionVote.create.mock.calls[0][0].data).toEqual({
      questionId: "q2", registrationId: "r1", eventId: "ev1", organizationId: "org1",
    });
  });

  it("voting again removes the vote (toggle)", async () => {
    asAttendee();
    mockDb.webinarQuestionVote.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.webinarQuestionVote.count.mockResolvedValue(0);
    expect(await (await post()).json()).toEqual({ voted: false, voteCount: 0 });
    expect(mockDb.webinarQuestionVote.deleteMany.mock.calls[0][0].where).toEqual({ questionId: "q2", registrationId: "r1" });
    expect(mockDb.webinarQuestionVote.create).not.toHaveBeenCalled();
  });

  it("only a public, not dismissed question on this webinar's room session takes votes", async () => {
    asAttendee();
    mockDb.webinarViewerQuestion.findFirst.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(mockDb.webinarViewerQuestion.findFirst.mock.calls[0][0].where).toEqual({
      id: "q2", eventId: "ev1", sessionId: "s1", isPublic: true, status: { not: "DISMISSED" },
    });
    expect(mockDb.webinarQuestionVote.create).not.toHaveBeenCalled();
  });

  it("another session than the webinar's room is refused", async () => {
    asAttendee();
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "WEBINAR", settings: { webinar: { sessionId: "other" } } });
    expect((await post()).status).toBe(404);
  });

  it("staff testing the page and unregistered viewers cannot vote", async () => {
    mockAuth.mockResolvedValue(organizer);
    expect((await post()).status).toBe(403);
    mockAuth.mockResolvedValue(attendee);
    mockDb.registration.findFirst.mockResolvedValue(null);
    expect((await post()).status).toBe(403);
    expect(mockDb.webinarQuestionVote.create).not.toHaveBeenCalled();
  });

  it("refused when the producer switched upvotes off, and the list says so", async () => {
    asAttendee();
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", eventType: "WEBINAR", settings: { webinar: { sessionId: "s1", qaUpvote: false } } });
    expect((await post()).status).toBe(403);
    mockDb.webinarViewerQuestion.findMany.mockResolvedValue([]);
    const body = await (await listMine(req(), publicParams)).json();
    expect(body).toMatchObject({ upvote: false, canVote: false });
  });

  it("a double click racing to the same vote counts once, not an error", async () => {
    asAttendee();
    mockDb.webinarQuestionVote.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).voted).toBe(true);
  });

  it("the list sorts shown questions by votes, then newest, and marks the viewer's own votes", async () => {
    asAttendee();
    mockDb.webinarViewerQuestion.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "new", question: "a", status: "NEW", askerName: "A B", createdAt: new Date("2026-10-06T10:02:00Z") },
        { id: "old", question: "b", status: "NEW", askerName: "C D", createdAt: new Date("2026-10-06T10:00:00Z") },
        { id: "mid", question: "c", status: "NEW", askerName: "E F", createdAt: new Date("2026-10-06T10:01:00Z") },
      ]);
    mockDb.webinarQuestionVote.groupBy.mockResolvedValue([{ questionId: "old", _count: { _all: 2 } }]);
    mockDb.webinarQuestionVote.findMany.mockResolvedValue([{ questionId: "old" }]);
    const body = await (await listMine(req(), publicParams)).json();
    expect(body.published.map((q: { id: string }) => q.id)).toEqual(["old", "new", "mid"]);
    expect(body.published[0]).toMatchObject({ voteCount: 2, votedByMe: true });
  });
});
