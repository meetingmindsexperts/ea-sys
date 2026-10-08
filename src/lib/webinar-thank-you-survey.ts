/**
 * The end-of-webinar survey link in the webinar thank-you email (step 5 of
 * several surveys, Oct 6, 2026; docs/MULTI_SURVEY_PLAN.md §14 step 5).
 *
 * When the producer picked an end-of-webinar survey (settings.webinar.endSurveyId)
 * the thank-you send gives each recipient their personal link to it, the same
 * three-part token an extra survey's invitation mints. People who already
 * answered on the attendee page get no link, and the block renders empty.
 *
 * NEVER the CME survey: the webinar PUT refuses it as endSurveyId and this
 * resolver refuses it again, so the thank-you can never hand every registrant
 * (attended or not) a certificate survey. A missing, closed or empty survey
 * sends the thank-you without the block; it never blocks the thank-you.
 */
import { db } from "./db";
import { apiLogger } from "./logger";
import { readWebinarSettings } from "./webinar";
import { parseStoredSurveyConfig } from "@/services/survey-service";
import { responseDedupKey, type SurveyResponseModeValue } from "./survey/response-mode";

export interface ThankYouSurvey {
  id: string;
  name: string;
  /** Phase 4: a daily survey counts only today's answers as "answered". */
  responseMode: SurveyResponseModeValue;
}

/** The survey the thank-you links to, or null when there is none to link. */
export async function resolveThankYouSurvey(event: { id: string; settings: unknown }): Promise<ThankYouSurvey | null> {
  const webinar = readWebinarSettings(event.settings);
  const surveyId = webinar?.endSurveyId;
  if (!surveyId) return null;
  // The organiser turned the link off in the Webinar Console.
  if (webinar?.thankYouSurveyLink === false) {
    apiLogger.info({ msg: "webinar-thank-you:survey-link-off", eventId: event.id, surveyId });
    return null;
  }
  const row = await db.survey.findFirst({
    where: { id: surveyId, eventId: event.id },
    select: { id: true, name: true, isActive: true, gatesCertificates: true, config: true, responseMode: true },
  });
  const skipReason = () => {
    if (!row) return "not-found";
    if (row.gatesCertificates) return "cme-survey";
    if (!row.isActive) return "closed";
    if (!parseStoredSurveyConfig(row.config, { eventId: event.id, surveyId: row.id })) return "no-questions";
    return null;
  };
  const reason = skipReason();
  if (!row || reason) {
    apiLogger.warn({ msg: "webinar-thank-you:survey-skipped", eventId: event.id, surveyId, reason });
    return null;
  }
  return { id: row.id, name: row.name, responseMode: row.responseMode };
}

/**
 * The registrations among `registrationIds` that already answered the survey:
 * any answer, or for a daily survey an answer today in the event's timezone
 * (the same rule as hasAnswered).
 */
export async function registrationsThatAnswered(
  surveyId: string,
  registrationIds: string[],
  daily?: { timezone: string | null },
): Promise<Set<string>> {
  if (registrationIds.length === 0) return new Set();
  const now = new Date();
  const rows = await db.surveyResponse.findMany({
    where: daily
      ? { surveyId, dedupKey: { in: registrationIds.map((id) => responseDedupKey("ONCE_PER_DAY", id, now, daily.timezone)) } }
      : { surveyId, registrationId: { in: registrationIds } },
    select: { registrationId: true },
  });
  return new Set(rows.map((r) => r.registrationId).filter((id): id is string => !!id));
}

/** The survey block, in the same button markup as the replay button beside it. */
export function buildThankYouSurveyBlock(link: string): { html: string; text: string } {
  if (!link) return { html: "", text: "" };
  return {
    html: `<div style="text-align:center; margin:20px 0;"><p style="margin:0 0 12px 0;">Tell us what you thought: it takes a minute.</p><a href="${link}" style="display:inline-block; background:#00aade; color:#ffffff; padding:12px 28px; border-radius:6px; text-decoration:none; font-weight:600;">Take the survey</a></div>`,
    text: `Tell us what you thought: ${link}`,
  };
}

/**
 * A saved thank-you template predates the block, so a block that resolved to
 * something is placed in it: before the signature when the template has one,
 * else at the end. Each part (HTML, plain text) is checked on its own, so a
 * part that already places the survey is left as the organiser wrote it and
 * a part that does not still gets the link (review of steps 1 to 5).
 */
const SURVEY_TOKENS = ["{{surveyBlock}}", "{{surveyBlockText}}", "{{surveyLink}}"];

function placeSurveyToken(body: string, token: string): string {
  if (SURVEY_TOKENS.some((t) => body.includes(t))) return body;
  return body.includes("{{organizerSignature}}")
    ? body.replace("{{organizerSignature}}", `${token}\n{{organizerSignature}}`)
    : `${body}\n${token}`;
}

export function withThankYouSurveyBlock<T extends { htmlContent: string; textContent: string | null }>(tpl: T): T {
  return {
    ...tpl,
    htmlContent: placeSurveyToken(tpl.htmlContent, "{{surveyBlock}}"),
    textContent: tpl.textContent === null ? null : placeSurveyToken(tpl.textContent, "{{surveyBlockText}}"),
  };
}
