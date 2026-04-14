/**
 * Zoom Reports API — webinar poll + Q&A fetches.
 *
 * Reference: GET /report/webinars/{webinarId}/polls
 *           GET /report/webinars/{webinarId}/qa
 *
 * Neither endpoint paginates in practice (polls and Q&A lists are small
 * compared to participant reports), but both return 404 until the report
 * is compiled (~30 min after webinar ends — same window as attendance).
 *
 * Polls response:
 *   { questions: Array<{ email?, name, question_details: Array<{ question, answer }> }> }
 *
 * Q&A response:
 *   { questions: Array<{ name, email?, question_details: Array<{ question, answer?, create_time }> }> }
 *
 * Both endpoints return per-participant grouped data — we flatten into
 * per-submission rows for our schema.
 */

import { zoomApiRequest } from "./client";
import { apiLogger } from "@/lib/logger";

// ── Poll report ────────────────────────────────────────────────────

export interface ZoomPollAnswer {
  question: string;
  answer: string;
}

export interface ZoomPollSubmission {
  email?: string;
  name: string;
  first_poll_participation_date_time?: string;
  question_details?: ZoomPollAnswer[];
}

export interface ZoomPollReport {
  id?: number;
  uuid?: string;
  topic?: string;
  questions?: ZoomPollSubmission[];
  start_time?: string;
}

/**
 * Fetch poll responses for a webinar. Returns null on 404 (report not
 * yet compiled or no polls were run). Throws on other errors.
 */
export async function getWebinarPollReport(
  organizationId: string,
  webinarId: string,
): Promise<ZoomPollReport | null> {
  const startedAt = Date.now();
  apiLogger.info({ orgId: organizationId, webinarId }, "zoom:fetching-poll-report");
  try {
    const response = await zoomApiRequest<ZoomPollReport>(
      organizationId,
      "GET",
      `/report/webinars/${encodeURIComponent(webinarId)}/polls`,
    );
    apiLogger.info(
      {
        orgId: organizationId,
        webinarId,
        submissionCount: response.questions?.length ?? 0,
        durationMs: Date.now() - startedAt,
      },
      "zoom:poll-report-fetched",
    );
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("404") ||
      message.includes("3001") ||
      message.toLowerCase().includes("not found")
    ) {
      apiLogger.info(
        { orgId: organizationId, webinarId, durationMs: Date.now() - startedAt },
        "zoom:poll-report-not-ready",
      );
      return null;
    }
    apiLogger.error(
      { err, orgId: organizationId, webinarId, durationMs: Date.now() - startedAt },
      "zoom:poll-report-fetch-failed",
    );
    throw err;
  }
}

// ── Q&A report ─────────────────────────────────────────────────────

export interface ZoomQaDetail {
  question: string;
  answer?: string;
  create_time?: string;
}

export interface ZoomQaParticipant {
  name: string;
  email?: string;
  question_details?: ZoomQaDetail[];
}

export interface ZoomQaReport {
  id?: number;
  uuid?: string;
  topic?: string;
  questions?: ZoomQaParticipant[];
  start_time?: string;
}

/**
 * Fetch Q&A entries for a webinar. Returns null on 404 (report not yet
 * compiled or Q&A wasn't enabled). Throws on other errors.
 */
export async function getWebinarQaReport(
  organizationId: string,
  webinarId: string,
): Promise<ZoomQaReport | null> {
  const startedAt = Date.now();
  apiLogger.info({ orgId: organizationId, webinarId }, "zoom:fetching-qa-report");
  try {
    const response = await zoomApiRequest<ZoomQaReport>(
      organizationId,
      "GET",
      `/report/webinars/${encodeURIComponent(webinarId)}/qa`,
    );
    apiLogger.info(
      {
        orgId: organizationId,
        webinarId,
        askerCount: response.questions?.length ?? 0,
        durationMs: Date.now() - startedAt,
      },
      "zoom:qa-report-fetched",
    );
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("404") ||
      message.includes("3001") ||
      message.toLowerCase().includes("not found")
    ) {
      apiLogger.info(
        { orgId: organizationId, webinarId, durationMs: Date.now() - startedAt },
        "zoom:qa-report-not-ready",
      );
      return null;
    }
    apiLogger.error(
      { err, orgId: organizationId, webinarId, durationMs: Date.now() - startedAt },
      "zoom:qa-report-fetch-failed",
    );
    throw err;
  }
}
