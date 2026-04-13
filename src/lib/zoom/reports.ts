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
