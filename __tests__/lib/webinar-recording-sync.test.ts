/**
 * Unit tests for src/lib/webinar-recording-sync.ts — focused on the
 * "give up on a never-recorded webinar" transition (audit/UX fix, June 23 2026):
 * a 404 that persists past RECORDING_NO_RECORDING_GRACE_MS marks the row EXPIRED
 * so the poller stops grinding the full 7-day window (e.g. for test webinars).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGetZoomRecordings, mockPickBest } = vi.hoisted(() => ({
  mockDb: { zoomMeeting: { findUnique: vi.fn(), update: vi.fn() } },
  mockGetZoomRecordings: vi.fn(),
  mockPickBest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/zoom", () => ({
  getZoomRecordings: mockGetZoomRecordings,
  pickBestRecordingFile: mockPickBest,
}));

import {
  syncRecordingForZoomMeeting,
  RECORDING_NO_RECORDING_GRACE_MS,
} from "@/lib/webinar-recording-sync";

function meetingEndedMsAgo(ms: number, recordingStatus = "PENDING") {
  return {
    id: "zm-1",
    zoomMeetingId: "82688059535",
    recordingStatus,
    recordingUrl: null,
    event: { id: "evt-1", organizationId: "org-1" },
    session: { endTime: new Date(Date.now() - ms) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.zoomMeeting.update.mockResolvedValue({});
  mockGetZoomRecordings.mockResolvedValue(null); // 404 / no recording
});

describe("syncRecordingForZoomMeeting — no-recording give-up", () => {
  it("keeps polling (PENDING, not EXPIRED) on a 404 WITHIN the grace window", async () => {
    // 1h after end: past the 10-min min-delay, well within the 6h grace.
    mockDb.zoomMeeting.findUnique.mockResolvedValue(
      meetingEndedMsAgo(60 * 60_000, "NOT_REQUESTED"),
    );
    const res = await syncRecordingForZoomMeeting("zm-1");
    expect(res).toMatchObject({ ok: true, status: "pending" });
    // It flips NOT_REQUESTED → PENDING, and never writes EXPIRED.
    const statuses = mockDb.zoomMeeting.update.mock.calls.map((c) => c[0].data.recordingStatus);
    expect(statuses).toContain("PENDING");
    expect(statuses).not.toContain("EXPIRED");
  });

  it("gives up (marks EXPIRED, stops polling) on a 404 PAST the grace window", async () => {
    // Ended longer ago than the grace, still inside the 7-day fetch window.
    mockDb.zoomMeeting.findUnique.mockResolvedValue(
      meetingEndedMsAgo(RECORDING_NO_RECORDING_GRACE_MS + 60 * 60_000),
    );
    const res = await syncRecordingForZoomMeeting("zm-1");
    expect(res).toMatchObject({ ok: true, status: "expired" });
    expect(mockDb.zoomMeeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "zm-1" },
        data: expect.objectContaining({ recordingStatus: "EXPIRED" }),
      }),
    );
  });

  it("does not poll Zoom before the min-delay after end", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(meetingEndedMsAgo(60_000)); // 1 min ago
    const res = await syncRecordingForZoomMeeting("zm-1");
    expect(res).toMatchObject({ ok: true, status: "pending" });
    expect(mockGetZoomRecordings).not.toHaveBeenCalled();
  });

  it("publishes AVAILABLE when a playable recording is found", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(meetingEndedMsAgo(60 * 60_000));
    mockGetZoomRecordings.mockResolvedValue({ recording_files: [{}], duration: 42 });
    mockPickBest.mockReturnValue({ play_url: "https://zoom.us/rec/play/abc", download_url: null });
    const res = await syncRecordingForZoomMeeting("zm-1");
    expect(res).toMatchObject({ ok: true, status: "available", recordingUrl: "https://zoom.us/rec/play/abc" });
    expect(mockDb.zoomMeeting.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ recordingStatus: "AVAILABLE" }) }),
    );
  });
});
