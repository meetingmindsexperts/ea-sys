import { apiLogger } from "@/lib/logger";
import { deleteZoomMeeting, deleteZoomWebinar } from "@/lib/zoom";

/**
 * Delete a meeting/webinar on Zoom's side.
 *
 * Zoom is an external system with its own lifecycle and its own bill. Three
 * call sites need to tear a remote meeting down, and before the program/agenda
 * review only one of them did it:
 *
 *   - the dedicated Zoom DELETE route (always did)
 *   - the create route's P2002 compensation (H2 — two concurrent POSTs both
 *     called Zoom's create API before the `sessionId @unique` constraint
 *     rejected the second ROW; the loser's remote meeting was orphaned,
 *     billable, and unreachable from the app)
 *   - session DELETE (H3 — the route had ZERO Zoom references, so deleting a
 *     session cascaded the local row away and left the meeting live on Zoom,
 *     still joinable via any previously-shared joinUrl)
 *
 * NEVER THROWS. A cleanup failure must not turn a successful local operation
 * into a 500 — the local state is authoritative and the orphan is logged loudly
 * enough to be reconciled by hand. Returns whether the remote delete succeeded
 * so callers can surface a warning.
 */
export async function deleteRemoteZoomMeeting(args: {
  organizationId: string;
  meetingType: string;
  zoomMeetingId: string;
  /** Where the teardown was triggered from — shows up in the log line. */
  reason: "zoom-route-delete" | "create-conflict-rollback" | "session-delete";
}): Promise<boolean> {
  const { organizationId, meetingType, zoomMeetingId, reason } = args;
  try {
    if (meetingType === "MEETING") {
      await deleteZoomMeeting(organizationId, zoomMeetingId);
    } else {
      await deleteZoomWebinar(organizationId, zoomMeetingId);
    }
    apiLogger.info({ zoomMeetingId, meetingType, reason }, "zoom:remote-meeting-deleted");
    return true;
  } catch (err) {
    // The remote meeting may already be gone (idempotent teardown), or Zoom may
    // be unreachable. Either way: log, don't fail the caller. An orphan on
    // Zoom's side costs capacity, not correctness.
    apiLogger.warn(
      { err, zoomMeetingId, meetingType, reason },
      "zoom:remote-meeting-delete-failed",
    );
    return false;
  }
}
