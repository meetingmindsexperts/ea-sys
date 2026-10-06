/**
 * Live polls (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §5): the console
 * routes, the attendee vote and the poll that rides the Q&A refresh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockAuth, mockTx } = vi.hoisted(() => {
  const mockTx = { livePoll: { updateMany: vi.fn(), update: vi.fn() } };
  return {
    mockTx,
    mockAuth: vi.fn(),
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      livePoll: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      livePollVote: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
      webinarViewerQuestion: { findMany: vi.fn() },
      webinarQuestionVote: { groupBy: vi.fn(), findMany: vi.fn() },
    },
  };
});

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    body: unknown;
    headers: Headers;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    async json() {
      return this.body;
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(body, init);
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/public-event", () => ({ publicEventWhere: vi.fn(async () => ({})) }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }), getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: vi.fn() }));

import { GET as listPolls, POST as createPoll } from "@/app/api/events/[eventId]/webinar/polls/route";
import { PATCH as patchPoll, DELETE as deletePoll } from "@/app/api/events/[eventId]/webinar/polls/[pollId]/route";
import { GET as exportPoll } from "@/app/api/events/[eventId]/webinar/polls/[pollId]/export/route";
import { POST as vote } from "@/app/api/public/events/[slug]/sessions/[sessionId]/polls/[pollId]/vote/route";
import { GET as listQuestions } from "@/app/api/public/events/[slug]/sessions/[sessionId]/questions/route";

const organizer = { user: { id: "u9", role: "ORGANIZER", organizationId: "org1", firstName: "Org", lastName: "Staff" } };
const member = { user: { id: "u8", role: "MEMBER", organizationId: "org1", firstName: "M", lastName: "B" } };
const attendee = { user: { id: "u1", role: "REGISTRANT", organizationId: null, firstName: "A", lastName: "B" } };
const OPTS = [{ id: "a", label: "Yes" }, { id: "b", label: "No" }];
let settings: Record<string, unknown> = {};
const staff = { params: Promise.resolve({ eventId: "ev1" }) };
const pollParams = { params: Promise.resolve({ eventId: "ev1", pollId: "p1" }) };
const voteParams = { params: Promise.resolve({ slug: "web", sessionId: "s1", pollId: "p1" }) };
const jsonReq = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  settings = { webinar: { sessionId: "s1", livePolls: true } };
  mockDb.event.findFirst.mockImplementation(async () => ({ id: "ev1", organizationId: "org1", eventType: "WEBINAR", settings }));
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", status: "OPEN", options: OPTS, allowMultiple: false, _count: { votes: 0 } });
  mockDb.livePoll.create.mockResolvedValue({ id: "p1" });
  mockDb.livePollVote.create.mockResolvedValue({});
  mockDb.livePollVote.findMany.mockResolvedValue([]);
  mockDb.livePollVote.findUnique.mockResolvedValue(null);
  mockDb.webinarViewerQuestion.findMany.mockResolvedValue([]);
  mockDb.webinarQuestionVote.groupBy.mockResolvedValue([]);
  mockDb.webinarQuestionVote.findMany.mockResolvedValue([]);
});
const asRegistrant = () => {
  mockAuth.mockResolvedValue(attendee);
  mockDb.registration.findFirst.mockResolvedValue({ id: "r1", attendee: { firstName: "A", lastName: "B" } });
};

describe("console", () => {
  it("creates a draft on the webinar's room session with option ids assigned", async () => {
    mockAuth.mockResolvedValue(organizer);
    const res = await createPoll(jsonReq({ question: "Do you agree?", options: ["Yes", "No"] }), staff);
    expect(res.status).toBe(201);
    const data = mockDb.livePoll.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: "ev1", organizationId: "org1", sessionId: "s1", question: "Do you agree?" });
    expect(data.options.map((o: { label: string }) => o.label)).toEqual(["Yes", "No"]);
    expect(new Set(data.options.map((o: { id: string }) => o.id)).size).toBe(2);
  });

  it("a read-only member cannot create or launch", async () => {
    mockAuth.mockResolvedValue(member);
    expect((await createPoll(jsonReq({ question: "Do you agree?", options: ["Yes", "No"] }), staff)).status).toBe(403);
    expect((await patchPoll(jsonReq({ action: "launch" }), pollParams)).status).toBe(403);
  });

  it("launch is refused while live polls are switched off", async () => {
    mockAuth.mockResolvedValue(organizer);
    settings = { webinar: { sessionId: "s1" } };
    const res = await patchPoll(jsonReq({ action: "launch" }), pollParams);
    expect(res.status).toBe(409);
    expect(mockTx.livePoll.update).not.toHaveBeenCalled();
  });

  it("launch opens this poll and closes any other open one in the same write", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", status: "DRAFT" });
    expect((await patchPoll(jsonReq({ action: "launch" }), pollParams)).status).toBe(200);
    expect(mockTx.livePoll.updateMany.mock.calls[0][0]).toMatchObject({
      where: { sessionId: "s1", eventId: "ev1", status: "OPEN", id: { not: "p1" } },
      data: { status: "CLOSED" },
    });
    expect(mockTx.livePoll.update.mock.calls[0][0]).toMatchObject({ where: { id: "p1" }, data: { status: "OPEN" } });
  });

  it("only a draft can be edited; a poll from another event or session is not found", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", status: "OPEN" });
    expect((await patchPoll(jsonReq({ question: "New?", options: ["A", "B"], allowMultiple: false }), pollParams)).status).toBe(409);
    mockDb.livePoll.findFirst.mockResolvedValue(null);
    expect((await patchPoll(jsonReq({ action: "close" }), pollParams)).status).toBe(404);
    expect(mockDb.livePoll.findFirst.mock.calls.at(-1)?.[0].where).toEqual({ id: "p1", eventId: "ev1", sessionId: "s1" });
  });

  it("a poll people answered cannot be deleted (kept as a record)", async () => {
    mockAuth.mockResolvedValue(organizer);
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", _count: { votes: 3 } });
    expect((await deletePoll(new Request("http://x"), pollParams)).status).toBe(409);
    expect(mockDb.livePoll.delete).not.toHaveBeenCalled();
  });

  it("lists polls with their tallies", async () => {
    mockAuth.mockResolvedValue(member);
    mockDb.livePoll.findMany.mockResolvedValue([{ id: "p1", question: "Q", options: OPTS, allowMultiple: false, status: "OPEN", showResults: false }]);
    mockDb.livePollVote.findMany.mockResolvedValue([{ pollId: "p1", choices: ["a"] }, { pollId: "p1", choices: ["b"] }, { pollId: "p1", choices: ["a"] }]);
    const body = (await (await listPolls(new Request("http://x"), staff)).json()) as { polls: { tally: unknown }[] };
    expect(body.polls[0].tally).toEqual({ counts: { a: 2, b: 1 }, voters: 3 });
  });

  it("export needs the attendance export permission (a member is refused)", async () => {
    mockAuth.mockResolvedValue(member);
    expect((await exportPoll(new Request("http://x"), pollParams)).status).toBe(403);
  });
});

describe("attendee vote", () => {
  it("records a registrant's answer, stamped with the event's org", async () => {
    asRegistrant();
    const res = await vote(jsonReq({ choices: ["a"] }), voteParams);
    expect(res.status).toBe(201);
    expect(mockDb.livePollVote.create.mock.calls[0][0].data).toEqual({
      pollId: "p1", registrationId: "r1", eventId: "ev1", organizationId: "org1", choices: ["a"],
    });
  });

  it("refused when polls are off, the poll is closed, the answer is not an option, or for staff", async () => {
    asRegistrant();
    settings = { webinar: { sessionId: "s1" } };
    expect((await vote(jsonReq({ choices: ["a"] }), voteParams)).status).toBe(403);
    settings = { webinar: { sessionId: "s1", livePolls: true } };
    mockDb.livePoll.findFirst.mockResolvedValueOnce({ id: "p1", status: "CLOSED", options: OPTS, allowMultiple: false });
    expect((await vote(jsonReq({ choices: ["a"] }), voteParams)).status).toBe(409);
    expect((await vote(jsonReq({ choices: ["a", "b"] }), voteParams)).status).toBe(400);
    mockAuth.mockResolvedValue(organizer);
    expect((await vote(jsonReq({ choices: ["a"] }), voteParams)).status).toBe(403);
    expect(mockDb.livePollVote.create).not.toHaveBeenCalled();
  });

  it("a second answer is refused (final once given)", async () => {
    asRegistrant();
    mockDb.livePollVote.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const res = await vote(jsonReq({ choices: ["b"] }), voteParams);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("ALREADY_ANSWERED");
  });
});

describe("the poll on the Q&A refresh", () => {
  const getQuestions = () => listQuestions(new Request("http://x"), { params: Promise.resolve({ slug: "web", sessionId: "s1" }) });

  it("the open poll arrives with this viewer's answer and no results until shown", async () => {
    asRegistrant();
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", question: "Q", options: OPTS, allowMultiple: false, status: "OPEN", showResults: false });
    mockDb.livePollVote.findUnique.mockResolvedValue({ choices: ["a"] });
    const body = (await (await getQuestions()).json()) as { poll: { myChoices: string[]; results: unknown }; canAnswerPoll: boolean };
    expect(body.poll).toMatchObject({ id: "p1", status: "OPEN", myChoices: ["a"], results: null });
    expect(body.canAnswerPoll).toBe(true);
    expect(mockDb.livePollVote.findMany).not.toHaveBeenCalled();
  });

  it("a closed poll shows only with results shown; switched off, nothing at all", async () => {
    asRegistrant();
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p1", question: "Q", options: OPTS, allowMultiple: false, status: "CLOSED", showResults: false });
    expect(((await (await getQuestions()).json()) as { poll: unknown }).poll).toBeNull();
    mockDb.livePoll.findFirst.mockResolvedValue({ id: "p2", question: "Q", options: OPTS, allowMultiple: false, status: "CLOSED", showResults: true });
    mockDb.livePollVote.findMany.mockResolvedValue([{ choices: ["b"] }]);
    const shown = (await (await getQuestions()).json()) as { poll: { results: unknown } };
    expect(shown.poll.results).toEqual({ counts: { a: 0, b: 1 }, voters: 1 });
    settings = { webinar: { sessionId: "s1" } };
    mockDb.livePoll.findFirst.mockClear();
    expect(((await (await getQuestions()).json()) as { poll: unknown }).poll).toBeNull();
    expect(mockDb.livePoll.findFirst).not.toHaveBeenCalled();
  });
});

describe("results never block answering (review of polls, HIGH)", () => {
  const getQuestions = () => listQuestions(new Request("http://x"), { params: Promise.resolve({ slug: "web", sessionId: "s1" }) });
  const OPEN_SHOWN = { id: "p1", question: "Q", options: OPTS, allowMultiple: false, status: "OPEN", showResults: true };

  it("an open poll with results shown: no results for a registrant who has not answered yet", async () => {
    asRegistrant();
    mockDb.livePoll.findFirst.mockResolvedValue(OPEN_SHOWN);
    mockDb.livePollVote.findUnique.mockResolvedValue(null);
    const body = (await (await getQuestions()).json()) as { poll: { myChoices: unknown; results: unknown } };
    expect(body.poll).toMatchObject({ myChoices: null, results: null });
    expect(mockDb.livePollVote.findMany).not.toHaveBeenCalled();
  });

  it("the same poll after answering: results arrive", async () => {
    asRegistrant();
    mockDb.livePoll.findFirst.mockResolvedValue({ ...OPEN_SHOWN, id: "p9" });
    mockDb.livePollVote.findUnique.mockResolvedValue({ choices: ["a"] });
    mockDb.livePollVote.findMany.mockResolvedValue([{ choices: ["a"] }]);
    const body = (await (await getQuestions()).json()) as { poll: { results: unknown } };
    expect(body.poll.results).toEqual({ counts: { a: 1, b: 0 }, voters: 1 });
  });
});
