import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getZoomRecordings, pickBestRecordingFile } from "@/lib/zoom";

// Recordings are typically available within a few minutes of a webinar ending
// but can take up to an hour for long sessions. We poll for up to 7 days; after
// that we flip the row to EXPIRED.
export const RECORDING_FETCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Don't even try until at least this long after the session ended — gives Zoom
// time to finalize the recording.
export const RECORDING_FETCH_MIN_DELAY_MS = 10 * 60 * 1000;

export type SyncResult =
  | { ok: true; status: "available"; recordingUrl: string; durationMs: number }
  | { ok: true; status: "pending"; reason: string; durationMs: number }
  | { ok: true; status: "expired"; durationMs: number }
  | { ok: false; status: "failed"; reason: string; durationMs: number };

/**
 * Fetch + persist recording URL for a single ZoomMeeting row. Idempotent.
 *
 * States:
 *   NOT_REQUESTED → polled: if 404/no files → PENDING, if AVAILABLE → AVAILABLE
 *   PENDING → polled: same transitions
 *   AVAILABLE → short-circuit, return current URL
 *   FAILED / EXPIRED → short-circuit (caller must reset status to retry)
 *
 * Throws only on programmer errors — all Zoom / DB failures are captured in
 * the returned result and logged.
 */
export async function syncRecordingForZoomMeeting(
  zoomMeetingDbId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();

  const meeting = await db.zoomMeeting.findUnique({
    where: { id: zoomMeetingDbId },
    select: {
      id: true,
      zoomMeetingId: true,
      recordingStatus: true,
      recordingUrl: true,
      event: { select: { id: true, organizationId: true } },
      session: { select: { endTime: true } },
    },
  });

  if (!meeting) {
    return { ok: false, status: "failed", reason: "zoom-meeting-not-found", durationMs: Date.now() - startedAt };
  }

  // Short-circuit terminal states
  if (meeting.recordingStatus === "AVAILABLE" && meeting.recordingUrl) {
    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      { zoomMeetingDbId: meeting.id, durationMs },
      "webinar-recording:short-circuit-available",
    );
    return {
      ok: true,
      status: "available",
      recordingUrl: meeting.recordingUrl,
      durationMs,
    };
  }
  if (meeting.recordingStatus === "FAILED" || meeting.recordingStatus === "EXPIRED") {
    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      { zoomMeetingDbId: meeting.id, status: meeting.recordingStatus, durationMs },
      "webinar-recording:short-circuit-terminal",
    );
    return {
      ok: true,
      status: "pending",
      reason: `recording previously marked ${meeting.recordingStatus} — skipping`,
      durationMs,
    };
  }

  // Don't poll until the session has actually ended (with a lead buffer).
  const endedAt = meeting.session?.endTime;
  if (!endedAt) {
    apiLogger.warn(
      { zoomMeetingDbId: meeting.id },
      "webinar-recording:no-end-time",
    );
    return {
      ok: true,
      status: "pending",
      reason: "anchor session has no endTime",
      durationMs: Date.now() - startedAt,
    };
  }
  const msSinceEnded = Date.now() - endedAt.getTime();
  if (msSinceEnded < RECORDING_FETCH_MIN_DELAY_MS) {
    return {
      ok: true,
      status: "pending",
      reason: "too soon after end (waiting for Zoom to finalize)",
      durationMs: Date.now() - startedAt,
    };
  }

  // Expire rows outside the fetch window. Wrap the update so a DB failure
  // here can't escape unhandled and crash the cron tick.
  if (msSinceEnded > RECORDING_FETCH_WINDOW_MS) {
    try {
      await db.zoomMeeting.update({
        where: { id: meeting.id },
        data: { recordingStatus: "EXPIRED", recordingFetchedAt: new Date() },
      });
    } catch (updateErr) {
      const durationMs = Date.now() - startedAt;
      apiLogger.error(
        { err: updateErr, zoomMeetingDbId: meeting.id, durationMs },
        "webinar-recording:expire-update-failed",
      );
      return {
        ok: false,
        status: "failed",
        reason: "failed to persist EXPIRED status",
        durationMs,
      };
    }
    apiLogger.info(
      { zoomMeetingDbId: meeting.id, msSinceEnded },
      "webinar-recording:expired",
    );
    return { ok: true, status: "expired", durationMs: Date.now() - startedAt };
  }

  try {
    const response = await getZoomRecordings(meeting.event.organizationId, meeting.zoomMeetingId);

    if (!response) {
      // 404 — recording not ready yet. Flip NOT_REQUESTED → PENDING so we keep polling.
      if (meeting.recordingStatus === "NOT_REQUESTED") {
        await db.zoomMeeting.update({
          where: { id: meeting.id },
          data: { recordingStatus: "PENDING" },
        });
      }
      const durationMs = Date.now() - startedAt;
      apiLogger.info(
        { zoomMeetingDbId: meeting.id, msSinceEnded, durationMs },
        "webinar-recording:not-ready",
      );
      return {
        ok: true,
        status: "pending",
        reason: "zoom returned 404 — recording not ready",
        durationMs,
      };
    }

    const file = pickBestRecordingFile(response);
    if (!file || !file.play_url) {
      if (meeting.recordingStatus === "NOT_REQUESTED") {
        await db.zoomMeeting.update({
          where: { id: meeting.id },
          data: { recordingStatus: "PENDING" },
        });
      }
      const durationMs = Date.now() - startedAt;
      apiLogger.warn(
        {
          zoomMeetingDbId: meeting.id,
          recordingFileCount: response.recording_files?.length ?? 0,
          durationMs,
        },
        "webinar-recording:no-playable-files",
      );
      return {
        ok: true,
        status: "pending",
        reason: "response had no playable files",
        durationMs,
      };
    }

    await db.zoomMeeting.update({
      where: { id: meeting.id },
      data: {
        recordingUrl: file.play_url,
        recordingPassword: response.password ?? null,
        recordingDownloadUrl: file.download_url ?? null,
        // Response.duration is in minutes, our column stores seconds.
        recordingDuration: response.duration ? response.duration * 60 : null,
        recordingFetchedAt: new Date(),
        recordingStatus: "AVAILABLE",
      },
    });

    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      {
        zoomMeetingDbId: meeting.id,
        eventId: meeting.event.id,
        recordingUrl: file.play_url,
        durationMs,
      },
      "webinar-recording:available",
    );

    return { ok: true, status: "available", recordingUrl: file.play_url, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : "unknown-error";
    apiLogger.error(
      { err, zoomMeetingDbId: meeting.id, durationMs },
      "webinar-recording:fetch-errored",
    );
    // Don't immediately mark FAILED — let the cron retry on the next tick.
    // Only NOT_REQUESTED → PENDING so the row stays eligible for polling.
    if (meeting.recordingStatus === "NOT_REQUESTED") {
      await db.zoomMeeting
        .update({ where: { id: meeting.id }, data: { recordingStatus: "PENDING" } })
        .catch((updateErr) =>
          apiLogger.error({ err: updateErr, zoomMeetingDbId: meeting.id }, "webinar-recording:status-update-failed"),
        );
    }
    return { ok: false, status: "failed", reason, durationMs };
  }
}
