import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getZoomParticipants, type ZoomParticipant } from "@/lib/zoom";

// Zoom needs ~30 min after a webinar ends before the participant report is
// available. Polling earlier just wastes API calls.
export const ATTENDANCE_FETCH_MIN_DELAY_MS = 30 * 60 * 1000;

// Stop polling 30 days after end. Reports are available longer than that
// from Zoom's side, but we don't want zombie cron rows accumulating forever.
export const ATTENDANCE_FETCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type AttendanceSyncResult =
  | {
      ok: true;
      status: "synced";
      fetched: number;
      upserted: number;
      matched: number;
      durationMs: number;
    }
  | {
      ok: true;
      status: "pending";
      reason: string;
      durationMs: number;
    }
  | {
      ok: false;
      status: "failed";
      reason: string;
      durationMs: number;
    };

/**
 * Build a case-insensitive email → registrationId lookup for one event.
 * Used to best-effort link attendance rows back to registrations so the
 * dashboard can show "registered vs attended" without an N+1 lookup loop.
 */
async function buildRegistrationLookup(eventId: string): Promise<Map<string, string>> {
  const registrations = await db.registration.findMany({
    where: { eventId },
    select: { id: true, attendee: { select: { email: true } } },
  });
  const lookup = new Map<string, string>();
  for (const reg of registrations) {
    const email = reg.attendee?.email?.trim().toLowerCase();
    if (email && !lookup.has(email)) {
      // First registration wins on duplicates (rare but happens when an event
      // allows duplicate email registrations across ticket types).
      lookup.set(email, reg.id);
    }
  }
  return lookup;
}

/**
 * Convert a Zoom participant record into the shape needed for upsert.
 * Returns null for malformed records (missing required fields).
 */
function toAttendanceRow(
  p: ZoomParticipant,
  registrationLookup: Map<string, string>,
): {
  zoomParticipantIdKey: string;
  joinTime: Date;
  data: {
    name: string;
    email: string | null;
    leaveTime: Date | null;
    durationSeconds: number;
    attentivenessScore: number | null;
    registrationId: string | null;
  };
} | null {
  if (!p.join_time) return null;
  const joinTime = new Date(p.join_time);
  if (Number.isNaN(joinTime.getTime())) return null;

  const leaveTime = p.leave_time ? new Date(p.leave_time) : null;
  const validLeave = leaveTime && !Number.isNaN(leaveTime.getTime()) ? leaveTime : null;

  // Fall back to user_id then a synthesized "name|join_time" key if Zoom
  // didn't provide either id field. The synthesized key keeps the upsert
  // unique constraint satisfied without losing the row.
  const zoomParticipantIdKey =
    p.id || p.user_id || `anon:${(p.name || "unknown").slice(0, 40)}`;

  const emailRaw = p.user_email?.trim() || null;
  const emailLower = emailRaw?.toLowerCase() ?? null;
  const registrationId = emailLower ? registrationLookup.get(emailLower) ?? null : null;

  // Zoom occasionally returns attentiveness_score as a string ("85%" or "85").
  let attentivenessScore: number | null = null;
  if (p.attentiveness_score !== undefined && p.attentiveness_score !== null) {
    const raw = String(p.attentiveness_score).replace("%", "").trim();
    const num = Number(raw);
    if (!Number.isNaN(num)) attentivenessScore = Math.round(num);
  }

  return {
    zoomParticipantIdKey,
    joinTime,
    data: {
      name: p.name || "Unknown",
      email: emailRaw,
      leaveTime: validLeave,
      durationSeconds: Math.max(0, Math.floor(p.duration ?? 0)),
      attentivenessScore,
      registrationId,
    },
  };
}

/**
 * Fetch + persist the participant report for one ZoomMeeting row. Idempotent:
 * upserts by (zoomMeetingId, zoomParticipantId, joinTime) so re-syncing after
 * late participants joins/leaves is safe and doesn't duplicate rows.
 *
 * States:
 *   no endTime / too soon / too old → pending, skip
 *   Zoom 404 (report not ready)     → pending, retry next tick
 *   got participants                → upsert all, update lastAttendanceSyncAt
 *   Zoom errored                    → failed, retry next tick
 */
export async function syncWebinarAttendance(
  zoomMeetingDbId: string,
): Promise<AttendanceSyncResult> {
  const startedAt = Date.now();

  const meeting = await db.zoomMeeting.findUnique({
    where: { id: zoomMeetingDbId },
    select: {
      id: true,
      zoomMeetingId: true,
      meetingType: true,
      eventId: true,
      sessionId: true,
      lastAttendanceSyncAt: true,
      event: { select: { organizationId: true } },
      session: { select: { endTime: true } },
    },
  });

  if (!meeting) {
    return {
      ok: false,
      status: "failed",
      reason: "zoom-meeting-not-found",
      durationMs: Date.now() - startedAt,
    };
  }

  const endedAt = meeting.session?.endTime;
  if (!endedAt) {
    apiLogger.warn(
      { zoomMeetingDbId: meeting.id },
      "webinar-attendance:no-end-time",
    );
    return {
      ok: true,
      status: "pending",
      reason: "anchor session has no endTime",
      durationMs: Date.now() - startedAt,
    };
  }

  const msSinceEnded = Date.now() - endedAt.getTime();
  if (msSinceEnded < ATTENDANCE_FETCH_MIN_DELAY_MS) {
    return {
      ok: true,
      status: "pending",
      reason: "too soon after end (Zoom report not ready yet)",
      durationMs: Date.now() - startedAt,
    };
  }

  if (msSinceEnded > ATTENDANCE_FETCH_WINDOW_MS) {
    apiLogger.info(
      { zoomMeetingDbId: meeting.id, msSinceEnded },
      "webinar-attendance:outside-fetch-window",
    );
    return {
      ok: true,
      status: "pending",
      reason: "outside attendance fetch window (>30 days post-event)",
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const participants = await getZoomParticipants(
      meeting.event.organizationId,
      meeting.zoomMeetingId,
      meeting.meetingType,
    );

    if (participants === null) {
      apiLogger.info(
        { zoomMeetingDbId: meeting.id, msSinceEnded },
        "webinar-attendance:report-not-ready",
      );
      return {
        ok: true,
        status: "pending",
        reason: "zoom returned 404 — report not ready",
        durationMs: Date.now() - startedAt,
      };
    }

    if (participants.length === 0) {
      // No attendees joined. Still mark as synced so the cron doesn't keep
      // re-polling forever.
      try {
        await db.zoomMeeting.update({
          where: { id: meeting.id },
          data: { lastAttendanceSyncAt: new Date() },
        });
      } catch (markErr) {
        apiLogger.error(
          { err: markErr, zoomMeetingDbId: meeting.id },
          "webinar-attendance:zero-participants-marker-failed",
        );
      }
      const durationMs = Date.now() - startedAt;
      apiLogger.info(
        { zoomMeetingDbId: meeting.id, durationMs },
        "webinar-attendance:zero-participants",
      );
      return {
        ok: true,
        status: "synced",
        fetched: 0,
        upserted: 0,
        matched: 0,
        durationMs,
      };
    }

    const registrationLookup = await buildRegistrationLookup(meeting.eventId);

    let upserted = 0;
    let matched = 0;
    let skipped = 0;

    // Upsert serially. Postgres handles ~hundreds-per-second easily and serial
    // upserts make it safe to interleave with the lastAttendanceSyncAt update
    // without a transaction.
    for (const p of participants) {
      const row = toAttendanceRow(p, registrationLookup);
      if (!row) {
        skipped += 1;
        continue;
      }
      try {
        await db.zoomAttendance.upsert({
          where: {
            zoomMeetingId_zoomParticipantId_joinTime: {
              zoomMeetingId: meeting.id,
              zoomParticipantId: row.zoomParticipantIdKey,
              joinTime: row.joinTime,
            },
          },
          create: {
            zoomMeetingId: meeting.id,
            eventId: meeting.eventId,
            sessionId: meeting.sessionId,
            zoomParticipantId: row.zoomParticipantIdKey,
            joinTime: row.joinTime,
            ...row.data,
          },
          update: {
            // Only update the fields that can legitimately change after a
            // partial sync (e.g. leaveTime arrives in a later report tick).
            leaveTime: row.data.leaveTime,
            durationSeconds: row.data.durationSeconds,
            attentivenessScore: row.data.attentivenessScore,
            registrationId: row.data.registrationId,
            email: row.data.email,
            name: row.data.name,
          },
        });
        upserted += 1;
        if (row.data.registrationId) matched += 1;
      } catch (rowErr) {
        skipped += 1;
        apiLogger.error(
          {
            err: rowErr,
            zoomMeetingDbId: meeting.id,
            participantKey: row.zoomParticipantIdKey,
          },
          "webinar-attendance:row-upsert-failed",
        );
      }
    }

    // Wrap the lastAttendanceSyncAt update in its own try/catch so a DB
    // failure here can't escape unhandled and crash the cron tick. The
    // upserts above already succeeded — failing to mark "synced at" just
    // means the next cron tick will re-process this row (still idempotent).
    try {
      await db.zoomMeeting.update({
        where: { id: meeting.id },
        data: { lastAttendanceSyncAt: new Date() },
      });
    } catch (markErr) {
      apiLogger.error(
        { err: markErr, zoomMeetingDbId: meeting.id },
        "webinar-attendance:sync-marker-update-failed",
      );
    }

    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      {
        zoomMeetingDbId: meeting.id,
        eventId: meeting.eventId,
        fetched: participants.length,
        upserted,
        matched,
        skipped,
        durationMs,
      },
      "webinar-attendance:synced",
    );

    return {
      ok: true,
      status: "synced",
      fetched: participants.length,
      upserted,
      matched,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : "unknown-error";
    apiLogger.error(
      { err, zoomMeetingDbId: meeting.id, durationMs },
      "webinar-attendance:fetch-errored",
    );
    return { ok: false, status: "failed", reason, durationMs };
  }
}
