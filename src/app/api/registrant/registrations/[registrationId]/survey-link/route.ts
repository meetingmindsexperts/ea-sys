import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { loadRegistrantScope, ownRegistrationWhere } from "@/lib/registrant-access";
import { checkRateLimit } from "@/lib/security";
import { DEFAULT_SURVEY_EXPIRY_DAYS } from "@/lib/survey/expiry";
import { hasAnswered, mintPersonalSurveyLink, resolveTokenSurvey } from "@/services/survey-service";

/**
 * POST /api/registrant/registrations/[registrationId]/survey-link
 *
 * The "Take survey" button on My events (docs/MY_PORTAL_PLAN.md, phase 3).
 * The emailed survey link cannot be shown again (the database keeps only its
 * hash), so the signed-in owner of the registration is issued a fresh personal
 * link and the browser goes there. The survey page then works exactly as from
 * the email: same token, same validation, same submit.
 *
 * WHO. Only the registration's owner, by the portal's own rule
 * (`ownRegistrationWhere`, registrant-access.ts), read from the database and
 * never from the session; anyone else gets the same 404 as a registration that
 * does not exist. Only a place at the event (CONFIRMED or CHECKED_IN), only
 * once the event has started, only a survey that is open and not yet answered:
 * the same conditions under which My events shows the button.
 *
 * WHAT IT REVOKES. mintPersonalSurveyLink's rules, shared with the Survey
 * Invitation: a new certificate-survey link replaces the emailed one (the
 * person is using this one), an answer-once survey's likewise, and a daily
 * survey's earlier links stay alive.
 *
 * The response carries a site-relative URL, so the link lands on whichever
 * host the person is on. The token itself is never logged.
 */

interface RouteParams {
  params: Promise<{ registrationId: string }>;
}

const bodySchema = z.object({
  /** null: the event's certificate survey (an event with no Survey row). */
  surveyId: z.string().min(1).max(64).nullable(),
});

const ROUTE = "registrant/registrations/[registrationId]/survey-link";
const ATTENDING = new Set(["CONFIRMED", "CHECKED_IN"]);

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { registrationId }] = await Promise.all([auth(), params]);
    const userId = session?.user?.id;
    if (!userId) {
      apiLogger.warn({ msg: "registrant/survey-link:unauthenticated", registrationId });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "registrant/survey-link:invalid-body", registrationId, userId, errors: parsed.error.flatten().fieldErrors });
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const { surveyId } = parsed.data;

    // 20 links / person / hour: each click mints one, and a person with
    // several surveys clicks several times; more than that is not a person.
    const rl = checkRateLimit({ key: `registrant-survey-link:${userId}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "registrant/survey-link:rate-limited", userId, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: 20, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    // A registrant is org-null, so the lane comes from the host, as sign-in does.
    const orgId = await resolveRequestOrgId(req);
    return await runWithTenantLane(orgId, { route: ROUTE, userId }, async () => {
      const scope = await loadRegistrantScope(userId, { sessionTokenVersion: session.user.tokenVersion });
      if (!scope) {
        apiLogger.warn({ msg: "registrant/survey-link:user-not-found", userId });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const registration = await db.registration.findFirst({
        where: { id: registrationId, ...ownRegistrationWhere(scope) },
        select: {
          id: true,
          status: true,
          surveyCompletedAt: true,
          event: { select: { id: true, slug: true, startDate: true, timezone: true, surveyConfig: true, surveyIntroHtml: true, surveyThankYouHtml: true } },
        },
      });
      if (!registration) {
        apiLogger.warn({ msg: "registrant/survey-link:registration-not-found", registrationId, userId });
        return NextResponse.json({ error: "Registration not found" }, { status: 404 });
      }
      const ctx = { registrationId, userId, eventId: registration.event.id, surveyId };
      if (!ATTENDING.has(registration.status)) {
        apiLogger.warn({ msg: "registrant/survey-link:not-attending", ...ctx, status: registration.status });
        return NextResponse.json({ error: "This registration is not confirmed.", code: "NOT_ATTENDING" }, { status: 409 });
      }
      if (registration.event.startDate.getTime() > Date.now()) {
        apiLogger.warn({ msg: "registrant/survey-link:event-not-started", ...ctx });
        return NextResponse.json({ error: "The survey opens once the event has started.", code: "NOT_STARTED" }, { status: 409 });
      }

      // The same resolution the survey page applies to the token, so the link
      // minted here opens exactly the survey the button named.
      const resolved = await resolveTokenSurvey(registration.event, surveyId);
      if (resolved.kind !== "ok") {
        apiLogger.warn({ msg: "registrant/survey-link:survey-unavailable", ...ctx, reason: resolved.kind });
        return NextResponse.json({ error: "This survey is closed.", code: "SURVEY_UNAVAILABLE" }, { status: 409 });
      }
      const survey = { id: resolved.survey.surveyId, gatesCertificates: resolved.survey.gatesCertificates, responseMode: resolved.survey.responseMode };
      const answered = await hasAnswered({
        survey,
        registration: { id: registration.id, surveyCompletedAt: registration.surveyCompletedAt },
        timezone: registration.event.timezone,
      });
      if (answered) {
        apiLogger.info({ msg: "registrant/survey-link:already-answered", ...ctx });
        return NextResponse.json({ error: "You have already answered this survey.", code: "ALREADY_ANSWERED" }, { status: 409 });
      }

      const url = await mintPersonalSurveyLink({
        survey,
        registrationId: registration.id,
        eventSlug: registration.event.slug,
        appUrl: "",
        expiryDays: DEFAULT_SURVEY_EXPIRY_DAYS,
      });
      apiLogger.info({ msg: "registrant/survey-link:issued", ...ctx, resolvedSurveyId: survey.id, certificate: survey.gatesCertificates });
      return NextResponse.json({ url });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "registrant/survey-link:failed" });
    return NextResponse.json({ error: "Could not open the survey. Please try again." }, { status: 500 });
  }
}
