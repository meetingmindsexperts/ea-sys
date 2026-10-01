/**
 * Closes a webinar's room when the webinar is actually over (Oct 1, 2026).
 *
 * Ending the webinar in Zoom never closed our room: the public page kept its
 * live view until a producer clicked "Close the room", deliberately, so an
 * overrunning webinar is not cut off at its scheduled end. This job closes
 * an open room when either
 *   - Zoom reports a final-looking end (see decideRoomClose), or
 *   - the room is still open two hours after the later of the scheduled end
 *     and the last re-open (safety net).
 * Closing is exactly what the console's button does: the anchor session
 * becomes COMPLETED, so attendees see "ended" and later the replay.
 */
import { db, dbOperator } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { readWebinarSettings } from "@/lib/webinar";
import { getLastZoomEndTime } from "@/lib/zoom/reports";

export const SAFETY_NET_MS = 2 * 60 * 60 * 1000;
export const MAX_ROOMS_PER_TICK = 20;
/** A Zoom end this long ago with no restart in between counts as final. */
export const RESTART_GRACE_MS = 5 * 60 * 1000;
/** A Zoom end earlier than this before the scheduled end is treated as a
 *  crash or a mistaken "End" the host will recover from, not the finish. */
export const EARLY_END_TOLERANCE_MS = 15 * 60 * 1000;

export type CloseDecision = "close-zoom-ended" | "close-safety-net" | "keep";

/**
 * Pure: should this open room close now?
 *
 * Zoom's past-webinar record only says when the LAST run ended; it cannot
 * say whether the host has started again since (code review, Oct 1, 2026: a
 * crashed host who restarts at 10:22 would otherwise lose every attendee at
 * 10:25). So a Zoom end closes the room only when it is final-looking: after
 * the room opened, no earlier than 15 minutes before the scheduled end, and
 * at least 5 minutes old. An early finish is closed by the producer or the
 * safety net. The safety net counts from the later of the scheduled end and
 * the last time the room was opened, so a deliberate re-open of an old room
 * is not closed again within minutes.
 */
export function decideRoomClose(input: {
  now: Date;
  scheduledEnd: Date;
  roomOpenedAt: Date | null;
  scheduledStart: Date;
  zoomEndedAt: Date | null;
}): CloseDecision {
  const { now, scheduledEnd, roomOpenedAt, scheduledStart, zoomEndedAt } = input;
  const safetyBase = Math.max(scheduledEnd.getTime(), roomOpenedAt?.getTime() ?? 0);
  if (now.getTime() > safetyBase + SAFETY_NET_MS) return "close-safety-net";
  if (!zoomEndedAt) return "keep";
  // Without a recorded open time (rooms opened before this shipped), fall back
  // to an hour before the scheduled start: still excludes yesterday's practice.
  const openedAt = roomOpenedAt ?? new Date(scheduledStart.getTime() - 60 * 60 * 1000);
  const endedAfterOpen = zoomEndedAt.getTime() > openedAt.getTime();
  const notTooEarly = zoomEndedAt.getTime() >= scheduledEnd.getTime() - EARLY_END_TOLERANCE_MS;
  const settled = now.getTime() - zoomEndedAt.getTime() >= RESTART_GRACE_MS;
  return endedAfterOpen && notTooEarly && settled ? "close-zoom-ended" : "keep";
}

/** Past the safety net there is no point asking Zoom. */
export function pastSafetyNet(now: Date, scheduledEnd: Date, roomOpenedAt: Date | null): boolean {
  return now.getTime() > Math.max(scheduledEnd.getTime(), roomOpenedAt?.getTime() ?? 0) + SAFETY_NET_MS;
}

export interface AutoCloseReport {
  checked: number;
  closed: number;
  failed: number;
}

export async function runWebinarRoomAutoCloseTick(now = new Date()): Promise<AutoCloseReport> {
  // Privileged lane: finding open rooms is a cross-tenant scan. Each room's
  // work then runs inside its own tenant on the normal client.
  const open = await dbOperator.eventSession.findMany({
    where: {
      status: "LIVE",
      event: { eventType: "WEBINAR" },
      zoomMeeting: { isNot: null },
    },
    take: MAX_ROOMS_PER_TICK,
    select: {
      id: true,
      eventId: true,
      startTime: true,
      endTime: true,
      event: { select: { organizationId: true, settings: true } },
      zoomMeeting: { select: { zoomMeetingId: true, meetingType: true } },
    },
  });

  const report: AutoCloseReport = { checked: 0, closed: 0, failed: 0 };
  for (const room of open) {
    const webinar = readWebinarSettings(room.event.settings);
    // Only the anchor session is "the room"; other sessions are not managed here.
    if (webinar?.sessionId !== room.id || !room.zoomMeeting) continue;
    report.checked += 1;
    try {
      const outcome = await runWithTenant(room.event.organizationId, async () => {
        const parsedOpen = webinar.roomOpenedAt ? new Date(webinar.roomOpenedAt) : null;
        const roomOpenedAt = parsedOpen && !Number.isNaN(parsedOpen.getTime()) ? parsedOpen : null;
        const zoomEndedAt =
          pastSafetyNet(now, room.endTime, roomOpenedAt)
            ? null
            : await getLastZoomEndTime(
                room.event.organizationId,
                room.zoomMeeting!.zoomMeetingId,
                room.zoomMeeting!.meetingType as "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
              );
        const decision = decideRoomClose({
          now,
          scheduledStart: room.startTime,
          scheduledEnd: room.endTime,
          roomOpenedAt,
          zoomEndedAt,
        });
        if (decision === "keep") return decision;
        // Guarded on LIVE so a producer's own close (or re-open) in between wins.
        const updated = await db.eventSession.updateMany({
          where: { id: room.id, eventId: room.eventId, status: "LIVE" },
          data: { status: "COMPLETED" },
        });
        if (updated.count === 0) return "keep";
        apiLogger.info(
          { eventId: room.eventId, sessionId: room.id, decision, zoomEndedAt: zoomEndedAt?.toISOString() },
          "webinar-room-autoclose:closed",
        );
        return decision;
      });
      if (outcome !== "keep") report.closed += 1;
    } catch (err) {
      report.failed += 1;
      apiLogger.error({ err, eventId: room.eventId, sessionId: room.id }, "webinar-room-autoclose:room-failed");
    }
  }
  if (report.checked > 0) apiLogger.info({ ...report }, "webinar-room-autoclose:tick");
  return report;
}
