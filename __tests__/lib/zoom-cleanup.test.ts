/**
 * deleteRemoteZoomMeeting — the single teardown path shared by the Zoom DELETE
 * route, the create route's P2002 rollback (H2), and session DELETE (H3).
 * Contract: routes by meetingType, logs the reason, and NEVER throws — a Zoom
 * outage must not fail a successful local operation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { delMeeting, delWebinar, mockApiLogger } = vi.hoisted(() => ({
  delMeeting: vi.fn(),
  delWebinar: vi.fn(),
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/zoom", () => ({
  deleteZoomMeeting: delMeeting,
  deleteZoomWebinar: delWebinar,
}));

import { deleteRemoteZoomMeeting } from "@/lib/zoom/cleanup";

beforeEach(() => {
  vi.clearAllMocks();
  delMeeting.mockResolvedValue(undefined);
  delWebinar.mockResolvedValue(undefined);
});

const base = { organizationId: "org1", zoomMeetingId: "999", reason: "session-delete" as const };

describe("deleteRemoteZoomMeeting", () => {
  it("uses the meeting API for MEETING", async () => {
    await expect(deleteRemoteZoomMeeting({ ...base, meetingType: "MEETING" })).resolves.toBe(true);
    expect(delMeeting).toHaveBeenCalledWith("org1", "999");
    expect(delWebinar).not.toHaveBeenCalled();
  });

  it.each(["WEBINAR", "WEBINAR_SERIES"])("uses the webinar API for %s", async (meetingType) => {
    await expect(deleteRemoteZoomMeeting({ ...base, meetingType })).resolves.toBe(true);
    expect(delWebinar).toHaveBeenCalledWith("org1", "999");
    expect(delMeeting).not.toHaveBeenCalled();
  });

  it("never throws when Zoom fails — returns false and warns", async () => {
    delMeeting.mockRejectedValue(new Error("Zoom 404: meeting not found"));
    await expect(deleteRemoteZoomMeeting({ ...base, meetingType: "MEETING" })).resolves.toBe(false);
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ zoomMeetingId: "999", reason: "session-delete" }),
      "zoom:remote-meeting-delete-failed",
    );
  });

  it("logs the triggering reason so an orphan can be traced", async () => {
    await deleteRemoteZoomMeeting({ ...base, meetingType: "MEETING", reason: "create-conflict-rollback" });
    expect(mockApiLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "create-conflict-rollback" }),
      "zoom:remote-meeting-deleted",
    );
  });
});
