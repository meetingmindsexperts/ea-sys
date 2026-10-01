/**
 * Closes a webinar's room when the webinar is actually over (Oct 1, 2026).
 *
 * Ending the webinar in Zoom never closed our room: the public page kept its
 * live view until a producer clicked "Close the room", deliberately, so an
 * overrunning webinar is not cut off at its scheduled end. This job closes
 * an open room when either
 *   - Zoom reports the webinar ended AFTER the room was opened (its
 *     past-webinar record; an earlier practice run of the same Zoom webinar
 *     ends before the room opened and is ignored), or
 *   - the room is still open two hours after the scheduled end (safety net).
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

export type CloseDecision = "close-zoom-ended" | "close-safety-net" | "keep";

/** Pure: should this open room close now? */
export function decideRoomClose(input: {
  now: Date;
  scheduledEnd: Date;
  roomOpenedAt: Date | null;
  scheduledStart: Date;
  zoomEndedAt: Date | null;
}): CloseDecision {
  const { now, scheduledEnd, roomOpenedAt, scheduledStart, zoomEndedAt } = input;
  if (now.getTime() > scheduledEnd.getTime() + SAFETY_NET_MS) return "close-safety-net";
  if (!zoomEndedAt) return "keep";
  // Without a recorded open time (rooms opened before this shipped), fall back
  // to an hour before the scheduled start: still excludes yesterday's practice.
  const openedAt = roomOpenedAt ?? new Date(scheduledStart.getTime() - 60 * 60 * 1000);
  return zoomEndedAt.getTime() > openedAt.getTime() ? "close-zoom-ended" : "keep";
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
        const zoomEndedAt =
          now.getTime() > room.endTime.getTime() + SAFETY_NET_MS
            ? null
            : await getLastZoomEndTime(
                room.event.organizationId,
                room.zoomMeeting!.zoomMeetingId,
                room.zoomMeeting!.meetingType as "MEETING" | "WEBINAR" | "WEBINAR_SERIES",
              );
        const roomOpenedAt = webinar.roomOpenedAt ? new Date(webinar.roomOpenedAt) : null;
        const decision = decideRoomClose({
          now,
          scheduledStart: room.startTime,
          scheduledEnd: room.endTime,
          roomOpenedAt: roomOpenedAt && !Number.isNaN(roomOpenedAt.getTime()) ? roomOpenedAt : null,
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
