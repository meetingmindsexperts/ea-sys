/**
 * Unit tests for src/lib/webinar-attendance.ts — focused on the
 * "give up on a webinar with no participant report" transition (June 23 2026):
 * a 404 ("meeting does not exist", code 3001) that persists past
 * ATTENDANCE_NO_REPORT_GRACE_MS marks the row synced so the cron stops
 * re-polling every tick (e.g. for test webinars).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockGetParticipants } = vi.hoisted(() => ({
  mockDb: {
    zoomMeeting: { findUnique: vi.fn(), update: vi.fn() },
    registration: { findMany: vi.fn() },
  },
  mockGetParticipants: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/zoom", () => ({ getZoomParticipants: mockGetParticipants }));

import {
  syncWebinarAttendance,
  ATTENDANCE_NO_REPORT_GRACE_MS,
} from "@/lib/webinar-attendance";

function meetingEndedMsAgo(ms: number) {
  return {
    id: "zm-1",
    zoomMeetingId: "82688059535",
    meetingType: "WEBINAR",
    eventId: "evt-1",
    sessionId: "sess-1",
    lastAttendanceSyncAt: null,
    event: { organizationId: "org-1" },
    session: { endTime: new Date(Date.now() - ms) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.zoomMeeting.update.mockResolvedValue({});
  mockDb.registration.findMany.mockResolvedValue([]);
  mockGetParticipants.mockResolvedValue(null); // 404 / no report
});

describe("syncWebinarAttendance — no-report give-up", () => {
  it("keeps retrying (pending, no marker) on a 404 WITHIN the grace window", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(meetingEndedMsAgo(60 * 60_000)); // 1h ago
    const res = await syncWebinarAttendance("zm-1");
    expect(res).toMatchObject({ ok: true, status: "pending" });
    expect(mockDb.zoomMeeting.update).not.toHaveBeenCalled();
  });

  it("gives up (marks lastAttendanceSyncAt, stops re-polling) on a 404 PAST the grace", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(
      meetingEndedMsAgo(ATTENDANCE_NO_REPORT_GRACE_MS + 60 * 60_000),
    );
    const res = await syncWebinarAttendance("zm-1");
    expect(res).toMatchObject({ ok: true, status: "synced", fetched: 0 });
    expect(mockDb.zoomMeeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "zm-1" },
        data: expect.objectContaining({ lastAttendanceSyncAt: expect.any(Date) }),
      }),
    );
  });

  it("does not poll Zoom before the min-delay after end", async () => {
    mockDb.zoomMeeting.findUnique.mockResolvedValue(meetingEndedMsAgo(60_000)); // 1 min ago
    const res = await syncWebinarAttendance("zm-1");
    expect(res).toMatchObject({ ok: true, status: "pending" });
    expect(mockGetParticipants).not.toHaveBeenCalled();
  });
});
