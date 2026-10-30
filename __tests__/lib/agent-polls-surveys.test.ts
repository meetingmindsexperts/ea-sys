/**
 * The agent's live poll and survey tools (Oct 30, 2026). The agent drafts and
 * reads, never runs: a poll it makes is a DRAFT, a survey it makes is CLOSED,
 * no tool launches or opens either, and runaway calls hit an hourly limit, a
 * ceiling or the duplicate check before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTx, rateLimit } = vi.hoisted(() => {
  const mockTx = { livePoll: { create: vi.fn() }, auditLog: { create: vi.fn() } };
  return {
    mockTx,
    rateLimit: vi.fn(),
    mockDb: {
      event: { findFirst: vi.fn() },
      livePoll: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
      livePollVote: { findMany: vi.fn() },
      survey: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
      surveyResponse: { findMany: vi.fn(), count: vi.fn() },
    },
  };
});
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockTx) }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: rateLimit }));
vi.mock("@/services/survey-service", async (orig) => ({
  ...(await orig<typeof import("@/services/survey-service")>()),
  createSurvey: vi.fn(async () => ({ ok: true, surveyId: "sv-new" })),
}));

import {
  ENGAGEMENT_EXECUTORS,
  MAX_SURVEYS_PER_EVENT,
  MAX_TEXT_ANSWERS_PER_QUESTION,
  MAX_WAITING_POLL_DRAFTS,
} from "@/lib/agent/tools/engagement";
import { createSurvey } from "@/services/survey-service";
import { collectToolsForActor } from "@/lib/agent/tool-registry";
import { isWriteTool } from "@/lib/agent/tools/_shared";
import { requiresApproval } from "@/lib/agent/approvals";
import { TOOL_PERMISSIONS } from "@/lib/permissions/tool-permissions";
import { activeCapabilityLimits } from "@/lib/agent/capabilities";
import { surfaceForTool } from "@/lib/agent/dashboard-links";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", source: "agent" as const, counters: { creates: 0, emailsSent: 0 } };
type Out = Record<string, unknown>;
const run = (tool: string, input: Record<string, unknown>) => ENGAGEMENT_EXECUTORS[tool](input, ctx) as Promise<Out>;
const POLL = { question: "Which session was most useful?", options: ["Morning", "Afternoon"] };
const SURVEY = { name: "Day 2 feedback", questions: [{ type: "rating_1_to_5", label: "Overall", required: true }] };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", organizationId: "org1", settings: { webinar: { sessionId: "s1", livePolls: true } },
    surveyConfig: null, surveyIntroHtml: null, surveyThankYouHtml: null,
  });
  mockDb.livePoll.count.mockResolvedValue(0);
  mockDb.livePoll.findFirst.mockResolvedValue(null);
  mockTx.livePoll.create.mockResolvedValue({ id: "p-new" });
  mockDb.survey.count.mockResolvedValue(0);
  mockDb.survey.findFirst.mockResolvedValue(null);
});

describe("registration", () => {
  const NAMES = ["list_live_polls", "create_live_poll", "list_surveys", "get_survey_results", "create_survey"];

  it("reaches both doors, each tool mapped to its console route's key, with a dashboard page", () => {
    for (const source of ["agent", "mcp"] as const) {
      const names = collectToolsForActor({ organizationId: "org", actor: { userId: "u1", role: "ADMIN", fromApiKey: source === "mcp" }, source }).map((t) => t.name);
      for (const n of NAMES) expect(names, `${source}:${n}`).toContain(n);
    }
    expect(TOOL_PERMISSIONS).toMatchObject({
      list_live_polls: "webinar.analytics.read",
      create_live_poll: "webinar.manage",
      list_surveys: "surveys.read",
      get_survey_results: "surveys.read",
      create_survey: "surveys.manage",
    });
    expect(surfaceForTool("create_live_poll")?.key).toBe("webinar");
    expect(surfaceForTool("get_survey_results")?.key).toBe("survey");
  });

  it("the creates are writes with no approval card; no run tool exists, so the prompt keeps saying so", () => {
    expect(isWriteTool("create_live_poll") && isWriteTool("create_survey")).toBe(true);
    expect(requiresApproval("create_live_poll") || requiresApproval("create_survey")).toBe(false);
    const tools = collectToolsForActor({ organizationId: "org", actor: { userId: "u1", role: "ADMIN", fromApiKey: false }, source: "agent" });
    expect(tools.some((t) => /^(launch|close|update|delete)_live_poll|^(open|update|delete|publish)_survey/.test(t.name))).toBe(false);
    const limits = activeCapabilityLimits(tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
    expect(limits.some((l) => l.text.startsWith("Launch, close or edit a live poll"))).toBe(true);
  });
});

describe("create_live_poll", () => {
  it("saves a DRAFT through the shared service, audited with the door", async () => {
    const res = await run("create_live_poll", POLL);
    expect(res).toMatchObject({ success: true, poll: { id: "p-new", status: "DRAFT" } });
    const data = mockTx.livePoll.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ eventId: "ev1", sessionId: "s1", question: POLL.question });
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("showResults");
    expect(mockTx.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "LIVE_POLL_CREATED", userId: "u1", changes: { source: "agent" } });
  });

  it("says the draft cannot launch while live polls are switched off", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: { webinar: { sessionId: "s1" } } });
    const res = await run("create_live_poll", POLL);
    expect(res.success).toBe(true);
    expect(String(res.message)).toContain("switched off");
  });

  it("refuses bad input before the rate limit or the database", async () => {
    expect(await run("create_live_poll", { question: "Q?", options: ["Only one"] })).toMatchObject({ code: "INVALID_POLL" });
    expect(await run("create_live_poll", { question: "Pick one", options: ["Yes", "yes"] })).toMatchObject({ code: "INVALID_POLL" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(mockTx.livePoll.create).not.toHaveBeenCalled();
  });

  it("refuses a non-webinar event", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1", settings: {} });
    expect(await run("create_live_poll", POLL)).toMatchObject({ code: "NO_WEBINAR_SESSION" });
    expect(mockTx.livePoll.create).not.toHaveBeenCalled();
  });

  it("stops a runaway: the hourly limit, the waiting-draft ceiling, a repeated question", async () => {
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 900 });
    expect(await run("create_live_poll", POLL)).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 900, limit: 30, windowSeconds: 3600 });
    expect(rateLimit.mock.calls[0][0].key).toBe("agent-poll-create:u1:ev1");

    mockDb.livePoll.count.mockResolvedValueOnce(MAX_WAITING_POLL_DRAFTS);
    expect(await run("create_live_poll", POLL)).toMatchObject({ code: "TOO_MANY_DRAFTS" });

    mockDb.livePoll.findFirst.mockResolvedValueOnce({ id: "p-old" });
    rateLimit.mockClear();
    expect(await run("create_live_poll", POLL)).toMatchObject({ code: "DUPLICATE_POLL", pollId: "p-old" });
    // A refused call does not use up the hour.
    expect(rateLimit).not.toHaveBeenCalled();
    expect(mockDb.livePoll.findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({ status: "DRAFT", question: { equals: POLL.question, mode: "insensitive" } });

    expect(mockTx.livePoll.create).not.toHaveBeenCalled();
  });
});

describe("create_survey", () => {
  it("creates it CLOSED, with fresh question ids and no HTML from the model", async () => {
    const res = await run("create_survey", {
      ...SURVEY,
      introHtml: "<script>x</script>",
      isActive: true,
      questions: [
        { type: "rating_1_to_5", label: "Overall", required: true },
        { type: "single_select", label: "Role", options: ["Doctor", "Nurse"] },
        { type: "text", label: "Comments", maxLength: 500 },
      ],
    });
    expect(res).toMatchObject({ success: true, survey: { id: "sv-new", isOpen: false, questions: 3 } });
    const [scope, fields] = vi.mocked(createSurvey).mock.calls[0];
    expect(scope).toMatchObject({ eventId: "ev1", userId: "u1", source: "agent" });
    expect(fields).toMatchObject({ isActive: false, introHtml: null, thankYouHtml: null, responseMode: "ONCE" });
    const ids = fields.config.map((q) => q.id);
    expect(new Set(ids).size).toBe(3);
    expect(fields.config[1]).toMatchObject({ type: "single_select", options: ["Doctor", "Nurse"], required: false });
  });

  it("refuses invalid questions before the rate limit", async () => {
    expect(await run("create_survey", { name: "X", questions: [] })).toMatchObject({ code: "INVALID_SURVEY" });
    expect(await run("create_survey", { name: "X", questions: [{ type: "single_select", label: "Pick", options: ["One"] }] })).toMatchObject({ code: "INVALID_SURVEY" });
    expect(await run("create_survey", { name: "  ", questions: SURVEY.questions })).toMatchObject({ code: "INVALID_SURVEY" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(createSurvey).not.toHaveBeenCalled();
  });

  it("stops a runaway: the hourly limit, the per-event ceiling, a name already used", async () => {
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });
    expect(await run("create_survey", SURVEY)).toMatchObject({ code: "RATE_LIMITED", limit: 5 });
    expect(rateLimit.mock.calls[0][0].key).toBe("agent-survey-create:u1:ev1");

    mockDb.survey.count.mockResolvedValueOnce(MAX_SURVEYS_PER_EVENT);
    expect(await run("create_survey", SURVEY)).toMatchObject({ code: "TOO_MANY_SURVEYS" });

    mockDb.survey.findFirst.mockResolvedValueOnce({ id: "sv-old" });
    rateLimit.mockClear();
    expect(await run("create_survey", SURVEY)).toMatchObject({ code: "DUPLICATE_SURVEY", surveyId: "sv-old" });
    expect(rateLimit).not.toHaveBeenCalled();

    expect(createSurvey).not.toHaveBeenCalled();
  });
});

describe("get_survey_results", () => {
  it("returns aggregates and the newest free-text answers, never who answered", async () => {
    const config = [
      { id: "q1", type: "rating_1_to_5", label: "Overall", required: true },
      { id: "q2", type: "text", label: "Comments", required: false },
    ];
    mockDb.survey.findFirst.mockResolvedValue({
      id: "sv1", eventId: "ev1", name: "Feedback", config, introHtml: null, thankYouHtml: null, isActive: true,
      sortOrder: 1, gatesCertificates: false, responseMode: "ONCE", createdAt: new Date(), updatedAt: new Date(),
    });
    const rows = Array.from({ length: MAX_TEXT_ANSWERS_PER_QUESTION + 5 }, (_, i) => ({
      id: `r${i}`, submittedAt: new Date(2026, 9, 1, 0, i), answers: { q1: 4, q2: `comment ${i}` },
    }));
    mockDb.surveyResponse.findMany.mockResolvedValue(rows);

    const res = await run("get_survey_results", { surveyId: "sv1" });
    expect(mockDb.surveyResponse.findMany.mock.calls[0][0].select).toEqual({ id: true, submittedAt: true, answers: true });
    expect(res.totalResponses).toBe(rows.length);
    const [rating, text] = res.questions as Array<Record<string, unknown>>;
    expect(rating).toMatchObject({ type: "rating_1_to_5", label: "Overall" });
    expect(text).toMatchObject({ type: "text", count: rows.length, shown: MAX_TEXT_ANSWERS_PER_QUESTION });
    const answers = text.answers as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(MAX_TEXT_ANSWERS_PER_QUESTION);
    expect(answers[0].value).toBe(`comment ${rows.length - 1}`);
    expect(Object.keys(answers[0]).sort()).toEqual(["submittedAt", "value"]);
  });

  it("a survey whose questions cannot be read still reports how many answered", async () => {
    mockDb.survey.findFirst.mockResolvedValue({
      id: "sv1", eventId: "ev1", name: "Old", config: [{ bogus: true }], introHtml: null, thankYouHtml: null, isActive: true,
      sortOrder: 1, gatesCertificates: false, responseMode: "ONCE", createdAt: new Date(), updatedAt: new Date(),
    });
    mockDb.surveyResponse.count.mockResolvedValue(7);
    expect(await run("get_survey_results", { surveyId: "sv1" })).toMatchObject({ totalResponses: 7, questions: [] });
  });

  it("an unknown survey is refused", async () => {
    mockDb.survey.findFirst.mockResolvedValue(null);
    expect(await run("get_survey_results", { surveyId: "nope" })).toMatchObject({ code: "SURVEY_NOT_FOUND" });
  });
});
