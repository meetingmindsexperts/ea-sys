/**
 * webinar-room-autoclose job — closes a webinar room once Zoom reports the
 * webinar ended (after the room opened), or two hours after the scheduled
 * end. Cadence: every 3 minutes, so attendees see "ended" within a few
 * minutes of the host ending the webinar (the page shows it at once). See src/lib/webinar/room-autoclose.ts.
 */
import { runWebinarRoomAutoCloseTick } from "@/lib/webinar/room-autoclose";
import { apiLogger } from "@/lib/logger";
import { withJobLock } from "../lib/job-lease";
import { JOB_IDS } from "../lib/job-ids";

export const JOB_NAME = "webinar-room-autoclose";
export const JOB_ID = JOB_IDS.WEBINAR_ROOM_AUTOCLOSE;
export const SCHEDULE = "0-59/3 * * * *"; // every 3 min; the offset that keeps every minute at 4 jobs or fewer

export async function tick(): Promise<void> {
  await withJobLock(JOB_ID, JOB_NAME, async () => {
    try {
      await runWebinarRoomAutoCloseTick();
    } catch (err) {
      apiLogger.error({ err, msg: "worker:tick-uncaught", job: JOB_NAME });
    }
  });
}
