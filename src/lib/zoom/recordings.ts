/**
 * Zoom cloud recording fetch functions.
 *
 * Zoom exposes recordings via:
 *   GET /meetings/{meetingId}/recordings       (works for both meetings & webinars)
 *   GET /webinars/{webinarId}/recordings       (webinar-only)
 *
 * The meetings endpoint is authoritative for both — Zoom treats a webinar's
 * numeric id as a "meeting" for recording purposes. We prefer the meetings
 * endpoint so this works for MEETING, WEBINAR, and WEBINAR_SERIES alike.
 *
 * Response shape (truncated to fields we use):
 *   {
 *     id: number,
 *     topic: string,
 *     duration: number,                // minutes
 *     total_size: number,              // bytes
 *     recording_count: number,
 *     password: string,                // recording playback password
 *     share_url?: string,              // public share URL (if set)
 *     recording_files: Array<{
 *       id: string,
 *       file_type: "MP4" | "M4A" | "TIMELINE" | "TRANSCRIPT" | "CHAT" | ...,
 *       file_extension: string,
 *       file_size: number,
 *       play_url: string,              // watch in browser
 *       download_url: string,          // download via OAuth token
 *       recording_start: string,
 *       recording_end: string,
 *       status: "completed" | "processing",
 *       recording_type: "shared_screen_with_speaker_view" | ...
 *     }>
 *   }
 *
 * Returns null for 404 (no recording yet / never recorded / recording expired).
 * Throws for all other non-2xx errors so callers can log + set FAILED.
 */

import { zoomApiRequest } from "./client";
import { apiLogger } from "@/lib/logger";

export interface ZoomRecordingFile {
  id: string;
  file_type: string;
  file_extension?: string;
  file_size?: number;
  play_url?: string;
  download_url?: string;
  recording_start?: string;
  recording_end?: string;
  status?: string;
  recording_type?: string;
}

export interface ZoomRecordingsResponse {
  id: number;
  topic: string;
  duration?: number;
  total_size?: number;
  recording_count?: number;
  password?: string;
  share_url?: string;
  recording_files?: ZoomRecordingFile[];
}

/**
 * Fetch cloud recordings for a Zoom meeting or webinar by its numeric id.
 * Returns null on 404 (recording not ready yet, never recorded, or expired).
 * Throws on all other errors.
 */
export async function getZoomRecordings(
  organizationId: string,
  meetingOrWebinarId: string,
): Promise<ZoomRecordingsResponse | null> {
  const startedAt = Date.now();
  apiLogger.info(
    { orgId: organizationId, zoomId: meetingOrWebinarId },
    "zoom:fetching-recordings",
  );
  try {
    const response = await zoomApiRequest<ZoomRecordingsResponse>(
      organizationId,
      "GET",
      `/meetings/${encodeURIComponent(meetingOrWebinarId)}/recordings`,
    );
    apiLogger.info(
      {
        orgId: organizationId,
        zoomId: meetingOrWebinarId,
        recordingCount: response.recording_count ?? response.recording_files?.length ?? 0,
        durationMs: Date.now() - startedAt,
      },
      "zoom:recordings-fetched",
    );
    return response;
  } catch (err) {
    // zoomApiRequest throws on non-2xx — inspect the message to detect 404.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("3301") || message.toLowerCase().includes("not found")) {
      apiLogger.info(
        {
          orgId: organizationId,
          zoomId: meetingOrWebinarId,
          durationMs: Date.now() - startedAt,
        },
        "zoom:recordings-not-ready",
      );
      return null;
    }
    apiLogger.error(
      { err, orgId: organizationId, zoomId: meetingOrWebinarId, durationMs: Date.now() - startedAt },
      "zoom:recordings-fetch-failed",
    );
    throw err;
  }
}

/**
 * Pick the best "watch" file from a recording response. Preference order:
 *   1. shared_screen_with_speaker_view MP4
 *   2. any MP4
 *   3. any file with a play_url
 * Returns null if nothing is playable.
 */
export function pickBestRecordingFile(
  response: ZoomRecordingsResponse,
): ZoomRecordingFile | null {
  const files = response.recording_files ?? [];
  if (files.length === 0) return null;

  const completed = files.filter((f) => (f.status ?? "completed") === "completed" && f.play_url);
  if (completed.length === 0) return null;

  const speakerView = completed.find(
    (f) => f.recording_type === "shared_screen_with_speaker_view" && f.file_type === "MP4",
  );
  if (speakerView) return speakerView;

  const anyMp4 = completed.find((f) => f.file_type === "MP4");
  if (anyMp4) return anyMp4;

  return completed[0];
}
