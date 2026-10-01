/**
 * Zoom Reports API — webinar/meeting participant fetches.
 *
 * Reference: GET /report/webinars/{webinarId}/participants
 *           GET /report/meetings/{meetingId}/participants
 *
 * Both endpoints return the same shape; we use the meeting endpoint when the
 * stored ZoomMeeting is type MEETING and the webinar endpoint for WEBINAR /
 * WEBINAR_SERIES.
 *
 * Response (truncated to fields we use):
 *   {
 *     page_size: number,
 *     total_records: number,
 *     next_page_token?: string,
 *     participants: Array<{
 *       id?: string,                 // unique per session per participant
 *       user_id?: string,            // alt id (panelists/registrants)
 *       name: string,
 *       user_email?: string,
 *       join_time: string,           // ISO 8601
 *       leave_time?: string,
 *       duration: number,            // seconds (sum if multiple join/leave segments)
 *       attentiveness_score?: string | number,
 *     }>
 *   }
 *
 * A single attendee can leave + rejoin → Zoom returns multiple rows for the
 * same user_email/user_id with different join_time. We persist one row per
 * segment so the attendance UI can show join/leave history.
 */

import { zoomApiRequest } from "./client";
import { apiLogger } from "@/lib/logger";

export interface ZoomParticipant {
  id?: string;
  user_id?: string;
  name: string;
  user_email?: string;
  join_time: string;
  leave_time?: string;
  duration: number;
  attentiveness_score?: string | number;
}

interface ZoomParticipantsPage {
  page_size: number;
  total_records: number;
  next_page_token?: string;
  participants?: ZoomParticipant[];
}

const PAGE_SIZE = 300;

/**
 * Fetch ALL participants for a webinar or meeting via Zoom's report API.
 * Walks the next_page_token cursor serially. Returns null on 404 (report
 * not yet available — Zoom needs ~30 min after a session ends to compile).
 */
export async function getZoomParticipants(
  organizationId: string,
  zoomId: string,
  type: "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
): Promise<ZoomParticipant[] | null> {
  const startedAt = Date.now();
  // Zoom's webinar participant report path; meeting type uses /meetings.
  const endpoint = type === "MEETING" ? "meetings" : "webinars";
  const basePath = `/report/${endpoint}/${encodeURIComponent(zoomId)}/participants`;

  apiLogger.info(
    { orgId: organizationId, zoomId, type },
    "zoom:fetching-participants",
  );

  const all: ZoomParticipant[] = [];
  let nextToken: string | undefined = undefined;
  let pageCount = 0;

  try {
    do {
      const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (nextToken) params.set("next_page_token", nextToken);

      const page: ZoomParticipantsPage = await zoomApiRequest<ZoomParticipantsPage>(
        organizationId,
        "GET",
        `${basePath}?${params.toString()}`,
        undefined,
        // 404 here is expected + recurring (report not compiled yet, or the
        // webinar — e.g. a test — has no Zoom report; code 3001). Suppress the
        // admin page for it; the catch below still returns null. Other statuses
        // still log at error + page.
        { expectedStatuses: [404] },
      );

      if (page.participants?.length) {
        all.push(...page.participants);
      }
      nextToken = page.next_page_token || undefined;
      pageCount += 1;

      // Hard stop on runaway pagination.
      if (pageCount > 100) {
        apiLogger.error(
          { orgId: organizationId, zoomId, pageCount },
          "zoom:participants-pagination-runaway",
        );
        break;
      }
    } while (nextToken);

    apiLogger.info(
      {
        orgId: organizationId,
        zoomId,
        type,
        participantCount: all.length,
        pageCount,
        durationMs: Date.now() - startedAt,
      },
      "zoom:participants-fetched",
    );

    return all;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("3001") || message.toLowerCase().includes("not found")) {
      apiLogger.info(
        { orgId: organizationId, zoomId, durationMs: Date.now() - startedAt },
        "zoom:participants-not-ready",
      );
      return null;
    }
    apiLogger.error(
      { err, orgId: organizationId, zoomId, durationMs: Date.now() - startedAt },
      "zoom:participants-fetch-failed",
    );
    throw err;
  }
}

/**
 * When the most recent run of a webinar (or meeting) ended, from Zoom's
 * past-webinar record; null while it has never ended or is unknown to Zoom.
 * Zoom's GET /webinars/{id} has no started/ended field, so this is the
 * supported way to learn that a host ended it (Oct 1, 2026). 400 and 404 are
 * the expected "not ended / not found" answers and log at debug.
 */
export async function getLastZoomEndTime(
  organizationId: string,
  zoomId: string,
  type: "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
): Promise<Date | null> {
  const endpoint = type === "MEETING" ? "past_meetings" : "past_webinars";
  try {
    const res = await zoomApiRequest<{ end_time?: string }>(
      organizationId,
      "GET",
      `/${endpoint}/${encodeURIComponent(zoomId)}`,
      undefined,
      { expectedStatuses: [400, 404] },
    );
    if (!res?.end_time) return null;
    const ended = new Date(res.end_time);
    return Number.isNaN(ended.getTime()) ? null : ended;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Zoom API error: (400|404)\b/.test(message)) return null;
    throw err;
  }
}
