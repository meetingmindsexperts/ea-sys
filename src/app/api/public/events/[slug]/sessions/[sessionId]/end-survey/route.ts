/**
 * The end-of-webinar survey on the attendee page (step 4 of several surveys,
 * Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §13 W1-W3).
 *
 *   GET  …/sessions/[sessionId]/end-survey   the survey the producer chose
 *        (settings.webinar.endSurveyId) and whether this viewer answered it
 *   POST …/sessions/[sessionId]/end-survey   { answers } submit it
 *
 * Identity is the page's own: a signed-in registrant of this webinar (the same
 * check as the Q&A box). No personal link is involved. Submitting goes through
 * the ONE survey submit (src/services/survey-service.ts).
 *
 * NEVER the CME survey (review of step 4): here any registrant, attended or
 * not, could complete it and be issued a certificate. The CME survey stays
 * reachable only through the personal link the organiser sends. The webinar
 * PUT refuses it as endSurveyId; this route refuses it again.
 *
 * Answers are accepted only once the webinar is over (the session COMPLETED, or
 * its scheduled end passed while not LIVE), the same condition the page uses.
 *
 * Only the anchor session of a WEBINAR event answers, and a COMPLETED event
 * still does: people answer after the webinar ends.
 */
import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { hasAnswered, parseStoredSurveyConfig, resolveTokenSurvey, submitSurveyResponse } from "@/services/survey-service";

type RouteParams = { params: Promise<{ slug: string; sessionId: string }> };

const submitSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

/** The webinar event, if this session is its room and a survey is chosen. */
async function loadContext(req: Request, slug: string, sessionId: string) {
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug, { statuses: ["DRAFT", "PUBLISHED", "LIVE", "COMPLETED"] }),
    select: {
      id: true,
      organizationId: true,
      eventType: true,
      settings: true,
      surveyConfig: true,
      surveyIntroHtml: true,
      surveyThankYouHtml: true,
      timezone: true,
    },
  });
  if (!event) return { kind: "no-event" as const };
  const webinar = readWebinarSettings(event.settings);
  if (event.eventType !== "WEBINAR" || webinar?.sessionId !== sessionId) return { kind: "not-the-room" as const };
  return { kind: "ok" as const, event, endSurveyId: webinar?.endSurveyId || null };
}

/** The viewer's registration on this event (staff and others have none). */
async function findRegistration(userId: string, eventId: string) {
  return db.registration.findFirst({
    where: { eventId, userId, status: { not: "CANCELLED" } },
    // Oldest first: GET and POST always land on the same row for someone
    // holding two (a delegate registration and a speaker companion).
    orderBy: { createdAt: "asc" },
    select: { id: true, surveyCompletedAt: true, attendee: { select: { id: true, tags: true } } },
  });
}

function hashIp(ip: string): string | null {
  const pepper = process.env.NEXTAUTH_SECRET;
  if (!pepper) return null;
  return crypto.createHash("sha256").update(`ip:${ip}:${pepper}`).digest("hex");
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }] = await Promise.all([auth(), params]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-end-survey-get:${authSession.user.id}`,
      limit: 120,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId }, "webinar-end-survey:get-rate-limited");
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
    }

    const ctx = await loadContext(req, slug, sessionId);
    if (ctx.kind !== "ok") {
      apiLogger.warn({ slug, sessionId, reason: ctx.kind }, "webinar-end-survey:not-available");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!ctx.endSurveyId) return NextResponse.json({ survey: null });

    return await runWithTenant(ctx.event.organizationId, async () => {
      const registration = await findRegistration(authSession.user.id, ctx.event.id);
      // Staff testing the page, or anyone not registered: no popup.
      if (!registration) {
        apiLogger.warn({ userId: authSession.user.id, eventId: ctx.event.id }, "webinar-end-survey:get-not-registered");
        return NextResponse.json({ survey: null, reason: "not-registered" });
      }

      const resolved = await resolveTokenSurvey(ctx.event, ctx.endSurveyId);
      if (resolved.kind !== "ok" || resolved.survey.gatesCertificates) {
        apiLogger.warn(
          { eventId: ctx.event.id, surveyId: ctx.endSurveyId, reason: resolved.kind === "ok" ? "cme-survey" : resolved.kind },
          "webinar-end-survey:get-survey-unavailable",
        );
        return NextResponse.json({ survey: null, reason: resolved.kind === "ok" ? "cme-survey" : resolved.kind });
      }
      const survey = resolved.survey;
      const config = parseStoredSurveyConfig(survey.config, { eventId: ctx.event.id, surveyId: survey.surveyId });
      if (!config) {
        apiLogger.warn({ eventId: ctx.event.id, surveyId: survey.surveyId }, "webinar-end-survey:get-no-questions");
        return NextResponse.json({ survey: null, reason: "no-questions" });
      }

      // The one shared rule (today, for a daily survey).
      const answered = await hasAnswered({
        survey: { id: survey.surveyId, gatesCertificates: survey.gatesCertificates, responseMode: survey.responseMode },
        registration: { id: registration.id, surveyCompletedAt: registration.surveyCompletedAt },
        timezone: ctx.event.timezone,
      });

      return NextResponse.json({
        survey: { id: survey.surveyId, introHtml: survey.introHtml, thankYouHtml: survey.thankYouHtml, config },
        answered,
      });
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-end-survey:get-failed");
    return NextResponse.json({ error: "Failed to load the survey" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [authSession, { slug, sessionId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!authSession?.user) {
      return NextResponse.json({ error: "Sign in required", code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `webinar-end-survey-post:${authSession.user.id}`,
      limit: 10,
      windowMs: 15 * 60_000,
    });
    if (!allowed) {
      apiLogger.warn({ userId: authSession.user.id, sessionId }, "webinar-end-survey:post-rate-limited");
      return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
    }
    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "webinar-end-survey:validation-failed");
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const ctx = await loadContext(req, slug, sessionId);
    if (ctx.kind !== "ok" || !ctx.endSurveyId) {
      apiLogger.warn({ slug, sessionId, reason: ctx.kind === "ok" ? "no-survey-chosen" : ctx.kind }, "webinar-end-survey:submit-not-available");
      return NextResponse.json({ error: "No survey is open for this webinar." }, { status: 404 });
    }

    return await runWithTenant(ctx.event.organizationId, async () => {
      const registration = await findRegistration(authSession.user.id, ctx.event.id);
      if (!registration?.attendee) {
        apiLogger.warn({ userId: authSession.user.id, eventId: ctx.event.id }, "webinar-end-survey:not-registered");
        return NextResponse.json({ error: "Not registered", code: "NOT_REGISTERED" }, { status: 403 });
      }
      const resolved = await resolveTokenSurvey(ctx.event, ctx.endSurveyId);
      if (resolved.kind !== "ok" || resolved.survey.gatesCertificates) {
        apiLogger.warn(
          { eventId: ctx.event.id, surveyId: ctx.endSurveyId, reason: resolved.kind === "ok" ? "cme-survey" : resolved.kind },
          "webinar-end-survey:survey-unavailable",
        );
        return NextResponse.json({ error: "This survey is closed." }, { status: 410 });
      }
      // Only once the webinar is over: the session COMPLETED, or its scheduled
      // end passed while it is not live.
      const sessionRow = await db.eventSession.findFirst({
        where: { id: sessionId, eventId: ctx.event.id },
        select: { status: true, endTime: true },
      });
      const over =
        !!sessionRow &&
        sessionRow.status !== "LIVE" &&
        (sessionRow.status === "COMPLETED" || sessionRow.endTime.getTime() < Date.now());
      if (!over) {
        apiLogger.warn({ eventId: ctx.event.id, sessionId, status: sessionRow?.status }, "webinar-end-survey:not-over-yet");
        return NextResponse.json({ error: "The survey opens when the webinar ends." }, { status: 409 });
      }
      const result = await submitSurveyResponse({
        survey: {
          id: resolved.survey.surveyId,
          eventId: ctx.event.id,
          gatesCertificates: resolved.survey.gatesCertificates,
          config: resolved.survey.config,
          responseMode: resolved.survey.responseMode,
        },
        timezone: ctx.event.timezone,
        registration: {
          id: registration.id,
          surveyCompletedAt: registration.surveyCompletedAt,
          attendee: { id: registration.attendee.id, tags: registration.attendee.tags },
        },
        organizationId: ctx.event.organizationId,
        rawAnswers: parsed.data.answers,
        ipHash: hashIp(getClientIp(req)),
      });
      if (!result.ok) {
        const status = result.code === "ANSWERS_INVALID" ? 400 : 404;
        return NextResponse.json(
          { error: result.message, ...(result.code === "ANSWERS_INVALID" && { details: { errors: result.errors } }) },
          { status },
        );
      }
      return NextResponse.json({ ok: true, alreadyCompleted: result.alreadyCompleted });
    });
  } catch (err) {
    apiLogger.error({ err }, "webinar-end-survey:submit-failed");
    return NextResponse.json({ error: "Failed to submit the survey" }, { status: 500 });
  }
}
