// Live polls and surveys: agent/MCP tools (Oct 30, 2026).
//
// The agent may DRAFT and READ, never run: a poll it makes is a DRAFT on the
// webinar's room session, a survey it makes is CLOSED, and there is no tool to
// launch, close, show results, open, edit or delete either. A person does
// those on the Webinar Console and the Survey page, so nothing the agent makes
// reaches an attendee on its own (owner decision, Oct 30, 2026).
//
// Runaway guards, on top of the tool gate's 20 writes per request:
//   - per person per event: 30 poll drafts and 5 surveys an hour;
//   - ceilings: 20 waiting drafts per webinar, 10 surveys per event;
//   - a poll whose question matches a waiting draft, or a survey whose name
//     the event already uses, is refused (a looping model repeats itself).
// The agent cannot write survey intro or thank-you HTML: that renders on a
// public page, and a person adds it in the builder.
//
// Creates go through the services the screens use (live-poll-service,
// survey-service), so they are audited with the door.
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { pollDraftSchema, percentOf } from "@/lib/webinar/live-polls";
import { listPollsWithTally, pollContextFor } from "@/lib/webinar/live-polls-server";
import { newQuestionId, surveyConfigSchema, type SurveyAnswerValue } from "@/lib/survey/schema";
import { aggregateSurvey, type SurveyResponseLike } from "@/lib/survey/aggregate";
import { createLivePollDraft } from "@/services/live-poll-service";
import { createSurvey, listSurveys, parseStoredSurveyConfig, resolveReportSurvey } from "@/services/survey-service";
import type { AgentContext, ToolExecutor } from "./_shared";

export const AGENT_POLL_CREATES_PER_HOUR = 30;
export const AGENT_SURVEY_CREATES_PER_HOUR = 5;
export const MAX_WAITING_POLL_DRAFTS = 20;
export const MAX_SURVEYS_PER_EVENT = 10;
/** Free-text answers returned per question, newest first. */
export const MAX_TEXT_ANSWERS_PER_QUESTION = 100;
const HOUR_MS = 3600_000;

type Refusal = { error: string; code: string; [k: string]: unknown };

function refuse(ctx: AgentContext, tool: string, refusal: Refusal): Refusal {
  apiLogger.warn({ msg: `agent:${tool}:refused`, code: refusal.code, eventId: ctx.eventId, userId: ctx.userId, source: ctx.source });
  return refusal;
}

/** The rate-limit refusal, in the shape every 429 carries (CLAUDE.md, Rate Limits). */
function rateLimited(ctx: AgentContext, tool: string, bucket: string, limit: number): Refusal | null {
  const rl = checkRateLimit({ key: `${bucket}:${ctx.userId}:${ctx.eventId}`, limit, windowMs: HOUR_MS });
  if (rl.allowed) return null;
  return refuse(ctx, tool, {
    error: `Rate limit reached: ${limit} per hour on this event. Retry after ${rl.retryAfterSeconds}s.`,
    code: "RATE_LIMITED",
    retryAfterSeconds: rl.retryAfterSeconds,
    limit,
    windowSeconds: HOUR_MS / 1000,
  });
}

// ── Live polls ──────────────────────────────────────────────────────────

const listLivePolls: ToolExecutor = async (_input, ctx) => {
  try {
    return await runWithTenant(ctx.organizationId, async () => {
      const poll = await pollContextFor({ id: ctx.eventId, organizationId: ctx.organizationId });
      if (!poll) return { error: "Event not found or access denied" };
      if (!poll.sessionId) return { livePollsEnabled: poll.enabled, polls: [], message: "This event has no webinar session, so it has no live polls." };
      const polls = await listPollsWithTally(poll.eventId, poll.sessionId);
      return {
        livePollsEnabled: poll.enabled,
        count: polls.length,
        polls: polls.map((p) => ({
          id: p.id,
          question: p.question,
          status: p.status,
          allowMultiple: p.allowMultiple,
          showResults: p.showResults,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
          createdAt: p.createdAt,
          voters: p.tally.voters,
          options: p.options.map((o) => ({
            label: o.label,
            votes: p.tally.counts[o.id] ?? 0,
            percent: percentOf(p.tally.counts[o.id] ?? 0, p.tally.voters),
          })),
        })),
      };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:list_live_polls failed");
    return { error: "Failed to load the live polls" };
  }
};

const createLivePoll: ToolExecutor = async (input, ctx) => {
  const TOOL = "create_live_poll";
  const parsed = pollDraftSchema.safeParse({
    question: input.question,
    options: input.options,
    allowMultiple: input.allowMultiple ?? false,
  });
  if (!parsed.success) {
    apiLogger.warn({ msg: `agent:${TOOL}:invalid`, eventId: ctx.eventId, errors: parsed.error.flatten() });
    return { error: parsed.error.issues[0]?.message ?? "Invalid poll", code: "INVALID_POLL" };
  }
  const limited = rateLimited(ctx, TOOL, "agent-poll-create", AGENT_POLL_CREATES_PER_HOUR);
  if (limited) return limited;

  try {
    return await runWithTenant(ctx.organizationId, async () => {
      const poll = await pollContextFor({ id: ctx.eventId, organizationId: ctx.organizationId });
      if (!poll) return refuse(ctx, TOOL, { error: "Event not found or access denied", code: "EVENT_NOT_FOUND" });
      if (!poll.sessionId) {
        return refuse(ctx, TOOL, { error: "This event has no webinar session, so it cannot hold live polls.", code: "NO_WEBINAR_SESSION" });
      }
      const { sessionId } = poll;
      const [waiting, duplicate] = await Promise.all([
        db.livePoll.count({ where: { eventId: poll.eventId, sessionId, status: "DRAFT" } }),
        db.livePoll.findFirst({
          where: { eventId: poll.eventId, sessionId, status: "DRAFT", question: { equals: parsed.data.question, mode: "insensitive" } },
          select: { id: true },
        }),
      ]);
      if (duplicate) {
        return refuse(ctx, TOOL, { error: "A draft with this question is already waiting. Nothing was created.", code: "DUPLICATE_POLL", pollId: duplicate.id });
      }
      if (waiting >= MAX_WAITING_POLL_DRAFTS) {
        return refuse(ctx, TOOL, {
          error: `This webinar already has ${waiting} draft polls waiting (the limit is ${MAX_WAITING_POLL_DRAFTS}). Launch or delete some on the Webinar Console first.`,
          code: "TOO_MANY_DRAFTS",
        });
      }

      const created = await createLivePollDraft(
        { eventId: poll.eventId, organizationId: poll.organizationId, sessionId, userId: ctx.userId, source: ctx.source },
        parsed.data,
      );
      return {
        success: true,
        poll: { id: created.pollId, question: parsed.data.question, options: parsed.data.options, allowMultiple: parsed.data.allowMultiple, status: "DRAFT" },
        message: poll.enabled
          ? "Saved as a draft. It is not live: a person launches it from the Webinar Console."
          : "Saved as a draft. Live polls are switched off for this webinar, so it cannot be launched until someone turns on Enable live polls in the Webinar Console.",
      };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:create_live_poll failed");
    return { error: "Failed to create the poll" };
  }
};

// ── Surveys ─────────────────────────────────────────────────────────────

const SURVEY_EVENT_SELECT = { id: true, organizationId: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true } as const;

function surveyEvent(ctx: AgentContext) {
  return db.event.findFirst({ where: { id: ctx.eventId, organizationId: ctx.organizationId }, select: SURVEY_EVENT_SELECT });
}

const listSurveysTool: ToolExecutor = async (_input, ctx) => {
  try {
    return await runWithTenant(ctx.organizationId, async () => {
      const event = await surveyEvent(ctx);
      if (!event) return { error: "Event not found or access denied" };
      const surveys = await listSurveys(event.id, event);
      return {
        count: surveys.length,
        surveys: surveys.map((s) => ({
          id: s.id,
          name: s.name,
          isOpen: s.isActive,
          isCertificateSurvey: s.gatesCertificates,
          responseMode: s.responseMode,
          questions: Array.isArray(s.config) ? s.config.length : 0,
          responses: s.responseCount,
        })),
      };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:list_surveys failed");
    return { error: "Failed to load the surveys" };
  }
};

const getSurveyResults: ToolExecutor = async (input, ctx) => {
  const surveyId = input.surveyId ? String(input.surveyId) : undefined;
  try {
    return await runWithTenant(ctx.organizationId, async () => {
      const event = await surveyEvent(ctx);
      if (!event) return { error: "Event not found or access denied" };
      const report = await resolveReportSurvey(event, surveyId);
      if (!report) return refuse(ctx, "get_survey_results", { error: `Survey "${surveyId}" not found on this event.`, code: "SURVEY_NOT_FOUND" });
      const config = parseStoredSurveyConfig(report.rawConfig, { eventId: event.id, surveyId });
      if (!config) return { survey: report.survey, totalResponses: 0, questions: [], message: "This survey has no questions." };

      // Answers only: no registration, so no respondent name or email.
      const rows = await db.surveyResponse.findMany({ where: report.where, select: { id: true, submittedAt: true, answers: true } });
      const responses = rows.map((r) => ({ ...r, answers: (r.answers ?? {}) as Record<string, SurveyAnswerValue> })) satisfies SurveyResponseLike[];
      const questions = aggregateSurvey(config, responses).map((q) => {
        if (q.type !== "text") return q;
        const newest = [...q.responses].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
        return {
          type: q.type,
          questionId: q.questionId,
          label: q.label,
          count: q.count,
          shown: Math.min(q.count, MAX_TEXT_ANSWERS_PER_QUESTION),
          answers: newest.slice(0, MAX_TEXT_ANSWERS_PER_QUESTION).map((a) => ({ submittedAt: a.submittedAt, value: a.value })),
        };
      });
      return { survey: report.survey, totalResponses: rows.length, questions };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId, surveyId }, "agent:get_survey_results failed");
    return { error: "Failed to load the survey results" };
  }
};

type QuestionInput = { type?: unknown; label?: unknown; required?: unknown; options?: unknown; maxLength?: unknown };

/** The model's questions as stored questions, each with a fresh id (schema.ts: never an index). */
function toSurveyQuestions(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q: QuestionInput) => {
    const base = { id: newQuestionId(), type: q.type, label: typeof q.label === "string" ? q.label.trim() : q.label, required: q.required === true };
    if (q.type === "single_select") return { ...base, options: q.options };
    if (q.type === "text" && q.maxLength !== undefined) return { ...base, maxLength: q.maxLength };
    return base;
  });
}

const createSurveyTool: ToolExecutor = async (input, ctx) => {
  const TOOL = "create_survey";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 120) {
    apiLogger.warn({ msg: `agent:${TOOL}:invalid`, eventId: ctx.eventId, field: "name" });
    return { error: "The survey needs a name of 1 to 120 characters.", code: "INVALID_SURVEY" };
  }
  const config = surveyConfigSchema.safeParse(toSurveyQuestions(input.questions));
  if (!config.success) {
    apiLogger.warn({ msg: `agent:${TOOL}:invalid`, eventId: ctx.eventId, errors: config.error.flatten() });
    const issue = config.error.issues[0];
    return { error: `Invalid questions: ${issue ? `${issue.path.join(".") || "questions"}: ${issue.message}` : "check the list"}`, code: "INVALID_SURVEY" };
  }
  const responseMode = input.responseMode === "ONCE_PER_DAY" ? "ONCE_PER_DAY" : "ONCE";
  const limited = rateLimited(ctx, TOOL, "agent-survey-create", AGENT_SURVEY_CREATES_PER_HOUR);
  if (limited) return limited;

  try {
    return await runWithTenant(ctx.organizationId, async () => {
      const event = await db.event.findFirst({ where: { id: ctx.eventId, organizationId: ctx.organizationId }, select: { id: true, organizationId: true } });
      if (!event) return refuse(ctx, TOOL, { error: "Event not found or access denied", code: "EVENT_NOT_FOUND" });
      const [existing, sameName] = await Promise.all([
        db.survey.count({ where: { eventId: event.id } }),
        db.survey.findFirst({ where: { eventId: event.id, name: { equals: name, mode: "insensitive" } }, select: { id: true } }),
      ]);
      if (sameName) {
        return refuse(ctx, TOOL, { error: `This event already has a survey named "${name}". Nothing was created.`, code: "DUPLICATE_SURVEY", surveyId: sameName.id });
      }
      if (existing >= MAX_SURVEYS_PER_EVENT) {
        return refuse(ctx, TOOL, {
          error: `This event already has ${existing} surveys (the limit for the assistant is ${MAX_SURVEYS_PER_EVENT}). Create more on the Survey page.`,
          code: "TOO_MANY_SURVEYS",
        });
      }

      const result = await createSurvey(
        { eventId: event.id, organizationId: event.organizationId, userId: ctx.userId, source: ctx.source },
        { name, config: config.data, introHtml: null, thankYouHtml: null, isActive: false, responseMode },
      );
      if (!result.ok) return refuse(ctx, TOOL, { error: result.message, code: result.code });
      return {
        success: true,
        survey: { id: result.surveyId, name, isOpen: false, questions: config.data.length, responseMode },
        message: "Created closed. Nobody can answer it until a person opens it on the Survey page, where the intro and thank-you text can also be added.",
      };
    });
  } catch (err) {
    apiLogger.error({ err, eventId: ctx.eventId }, "agent:create_survey failed");
    return { error: "Failed to create the survey" };
  }
};

export const ENGAGEMENT_EXECUTORS: Record<string, ToolExecutor> = {
  list_live_polls: listLivePolls,
  create_live_poll: createLivePoll,
  list_surveys: listSurveysTool,
  get_survey_results: getSurveyResults,
  create_survey: createSurveyTool,
};
