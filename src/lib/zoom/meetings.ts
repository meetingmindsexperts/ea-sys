/**
 * Zoom Meeting & Webinar management functions.
 * All functions call the Zoom REST API via the authenticated client.
 */

import { zoomApiRequest } from "./client";
import { apiLogger } from "@/lib/logger";
import type {
  CreateZoomMeetingParams,
  CreateZoomWebinarParams,
  ZoomMeetingResponse,
  ZoomWebinarResponse,
  ZoomPanelist,
} from "./types";

// ── Meetings ───────────────────────────────────────────────────────

export async function createZoomMeeting(
  organizationId: string,
  params: CreateZoomMeetingParams,
): Promise<ZoomMeetingResponse> {
  apiLogger.info({ orgId: organizationId, topic: params.topic }, "zoom:creating-meeting");
  return zoomApiRequest<ZoomMeetingResponse>(organizationId, "POST", "/users/me/meetings", {
    topic: params.topic,
    type: 2, // scheduled
    start_time: params.startTime,
    duration: params.duration,
    timezone: params.timezone || "UTC",
    password: params.passcode,
    agenda: params.agenda,
    settings: {
      waiting_room: params.waitingRoom ?? true,
      auto_recording: params.autoRecording || "none",
      join_before_host: false,
      mute_upon_entry: true,
      approval_type: 2, // no registration required
    },
  });
}

export async function getZoomMeeting(
  organizationId: string,
  meetingId: string,
): Promise<ZoomMeetingResponse> {
  return zoomApiRequest<ZoomMeetingResponse>(
    organizationId,
    "GET",
    `/meetings/${meetingId}`,
  );
}

export async function updateZoomMeeting(
  organizationId: string,
  meetingId: string,
  params: Partial<CreateZoomMeetingParams>,
): Promise<void> {
  await zoomApiRequest<void>(organizationId, "PATCH", `/meetings/${meetingId}`, {
    ...(params.topic && { topic: params.topic }),
    ...(params.startTime && { start_time: params.startTime }),
    ...(params.duration && { duration: params.duration }),
    ...(params.timezone && { timezone: params.timezone }),
    ...(params.passcode !== undefined && { password: params.passcode }),
    ...(params.agenda !== undefined && { agenda: params.agenda }),
    settings: {
      ...(params.waitingRoom !== undefined && { waiting_room: params.waitingRoom }),
      ...(params.autoRecording && { auto_recording: params.autoRecording }),
    },
  });
}

export async function deleteZoomMeeting(
  organizationId: string,
  meetingId: string,
): Promise<void> {
  apiLogger.info({ orgId: organizationId, meetingId }, "zoom:deleting-meeting");
  await zoomApiRequest<void>(organizationId, "DELETE", `/meetings/${meetingId}`);
}

// ── Webinars ───────────────────────────────────────────────────────

// Q&A settings applied to every webinar we create so attendees can ask
// questions via Zoom's native panel inside the Component View embed.
// Zoom's account default is not guaranteed across orgs.
const WEBINAR_QA_SETTINGS = {
  question_and_answer: {
    enable: true,
    allow_anonymous_questions: true,
    answer_questions: "all",
    attendees_can_upvote: true,
    attendees_can_comment: true,
  },
  hd_video: true,
  meeting_authentication: false,
} as const;

export async function createZoomWebinar(
  organizationId: string,
  params: CreateZoomWebinarParams,
): Promise<ZoomWebinarResponse> {
  apiLogger.info({ orgId: organizationId, topic: params.topic }, "zoom:creating-webinar");
  return zoomApiRequest<ZoomWebinarResponse>(organizationId, "POST", "/users/me/webinars", {
    topic: params.topic,
    type: 5, // scheduled webinar
    start_time: params.startTime,
    duration: params.duration,
    timezone: params.timezone || "UTC",
    password: params.passcode,
    agenda: params.agenda,
    settings: {
      auto_recording: params.autoRecording || "none",
      approval_type: 2, // no registration required — we gate on our side
      panelists_invitation_email_notification: false,
      ...WEBINAR_QA_SETTINGS,
    },
  });
}

export async function createWebinarSeries(
  organizationId: string,
  params: CreateZoomWebinarParams,
): Promise<ZoomWebinarResponse> {
  if (!params.recurrence) {
    throw new Error("Recurrence configuration is required for webinar series");
  }

  apiLogger.info({ orgId: organizationId, topic: params.topic, recurrence: params.recurrence.type }, "zoom:creating-webinar-series");
  return zoomApiRequest<ZoomWebinarResponse>(organizationId, "POST", "/users/me/webinars", {
    topic: params.topic,
    type: 9, // recurring webinar with fixed time
    start_time: params.startTime,
    duration: params.duration,
    timezone: params.timezone || "UTC",
    password: params.passcode,
    agenda: params.agenda,
    recurrence: params.recurrence,
    settings: {
      auto_recording: params.autoRecording || "none",
      approval_type: 2,
      panelists_invitation_email_notification: false,
      ...WEBINAR_QA_SETTINGS,
    },
  });
}

// Backfill Q&A (and related) settings on an existing webinar.
// Used by the manual "Re-run provisioner" button so organizers can push
// Q&A onto webinars that were created before we explicitly enabled it.
export async function enableWebinarQA(
  organizationId: string,
  webinarId: string,
): Promise<void> {
  apiLogger.info({ orgId: organizationId, webinarId }, "zoom:enabling-qa");
  await zoomApiRequest<void>(organizationId, "PATCH", `/webinars/${webinarId}`, {
    settings: WEBINAR_QA_SETTINGS,
  });
}

export async function getZoomWebinar(
  organizationId: string,
  webinarId: string,
  showPreviousOccurrences = false,
): Promise<ZoomWebinarResponse> {
  const query = showPreviousOccurrences ? "?show_previous_occurrences=true" : "";
  return zoomApiRequest<ZoomWebinarResponse>(
    organizationId,
    "GET",
    `/webinars/${webinarId}${query}`,
  );
}

export async function updateZoomWebinar(
  organizationId: string,
  webinarId: string,
  params: Partial<CreateZoomWebinarParams>,
): Promise<void> {
  await zoomApiRequest<void>(organizationId, "PATCH", `/webinars/${webinarId}`, {
    ...(params.topic && { topic: params.topic }),
    ...(params.startTime && { start_time: params.startTime }),
    ...(params.duration && { duration: params.duration }),
    ...(params.timezone && { timezone: params.timezone }),
    ...(params.passcode !== undefined && { password: params.passcode }),
    ...(params.agenda !== undefined && { agenda: params.agenda }),
    ...(params.recurrence && { recurrence: params.recurrence }),
    settings: {
      ...(params.autoRecording && { auto_recording: params.autoRecording }),
    },
  });
}

export async function deleteZoomWebinar(
  organizationId: string,
  webinarId: string,
): Promise<void> {
  apiLogger.info({ orgId: organizationId, webinarId }, "zoom:deleting-webinar");
  await zoomApiRequest<void>(organizationId, "DELETE", `/webinars/${webinarId}`);
}

// ── Live Streaming (RTMP → MediaMTX) ───────────────────────────────

export async function enableZoomLiveStreaming(
  organizationId: string,
  meetingId: string,
  rtmpUrl: string,
  streamKey: string,
  pageUrl?: string,
): Promise<void> {
  apiLogger.info({ orgId: organizationId, meetingId, streamKey }, "zoom:enabling-live-stream");
  await zoomApiRequest<void>(organizationId, "PATCH", `/meetings/${meetingId}/livestream`, {
    stream_url: rtmpUrl,
    stream_key: streamKey,
    page_url: pageUrl || "",
  });
}

export async function enableWebinarLiveStreaming(
  organizationId: string,
  webinarId: string,
  rtmpUrl: string,
  streamKey: string,
  pageUrl?: string,
): Promise<void> {
  apiLogger.info({ orgId: organizationId, webinarId, streamKey }, "zoom:enabling-webinar-live-stream");
  await zoomApiRequest<void>(organizationId, "PATCH", `/webinars/${webinarId}/livestream`, {
    stream_url: rtmpUrl,
    stream_key: streamKey,
    page_url: pageUrl || "",
  });
}

// ── Panelists ──────────────────────────────────────────────────────

// NOTE: Zoom's POST /panelists response does NOT reliably include join_url
// per panelist (known API quirk; Zoom staff recommend calling GET /panelists
// afterwards). We return void and let callers do a follow-up list call.
export async function addWebinarPanelists(
  organizationId: string,
  webinarId: string,
  panelists: { name: string; email: string }[],
): Promise<void> {
  apiLogger.info({ orgId: organizationId, webinarId, count: panelists.length }, "zoom:adding-panelists");
  await zoomApiRequest<void>(organizationId, "POST", `/webinars/${webinarId}/panelists`, {
    panelists,
  });
}

export async function listWebinarPanelists(
  organizationId: string,
  webinarId: string,
): Promise<ZoomPanelist[]> {
  const response = await zoomApiRequest<{ panelists: ZoomPanelist[] }>(
    organizationId,
    "GET",
    `/webinars/${webinarId}/panelists`,
  );
  return response.panelists;
}

export async function removeWebinarPanelist(
  organizationId: string,
  webinarId: string,
  panelistId: string,
): Promise<void> {
  await zoomApiRequest<void>(
    organizationId,
    "DELETE",
    `/webinars/${webinarId}/panelists/${panelistId}`,
  );
}
