/**
 * The agent's create_zoom_meeting asks the one-source rule before it calls
 * Zoom (Nov 12, 2026, external streams step 4): a partner-produced webinar, or
 * a session holding a partner's stream key, gets no Zoom meeting of ours.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockZoom, mockCleanup, mockLogger } = vi.hoisted(() => ({
  mockDb: {
    $queryRaw: vi.fn(),
    event: { findFirst: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn(), create: vi.fn() },
    externalStream: { findFirst: vi.fn() },
  },
  mockZoom: { isZoomConfigured: vi.fn(), createZoomMeeting: vi.fn(), createZoomWebinar: vi.fn() },
  mockCleanup: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: (fn: (tx: unknown) => unknown) => fn(mockDb) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/zoom", () => mockZoom);
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: mockCleanup }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }) }));

import { WEBINAR_EXECUTORS } from "@/lib/agent/tools/webinar";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1" } as never;
const create = (input: Record<string, unknown> = { sessionId: "s1", meetingType: "WEBINAR" }) =>
  WEBINAR_EXECUTORS.create_zoom_meeting(input, ctx) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockZoom.isZoomConfigured.mockResolvedValue(true);
  mockZoom.createZoomWebinar.mockResolvedValue({ id: 777, join_url: "j", start_url: "s", password: "p" });
  mockDb.eventSession.findFirst.mockResolvedValue({
    id: "s1",
    name: "Webinar",
    startTime: new Date("2026-12-01T10:00:00Z"),
    endTime: new Date("2026-12-01T11:00:00Z"),
    description: null,
  });
  mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
  mockDb.zoomMeeting.create.mockResolvedValue({ id: "zm1", zoomMeetingId: "777", joinUrl: "j" });
  mockDb.externalStream.findFirst.mockReset();
  mockDb.externalStream.findFirst.mockResolvedValue(null);
  mockDb.event.findFirst.mockResolvedValue({ timezone: "Asia/Dubai", eventType: "WEBINAR", settings: { webinar: { sessionId: "s1" } } });
  mockCleanup.mockResolvedValue(true);
});

describe("create_zoom_meeting and the one-source rule", () => {
  it("creates the meeting on an ordinary webinar session, under the per-session lock", async () => {
    const res = await create();
    expect(res.error).toBeUndefined();
    expect(mockZoom.createZoomWebinar).toHaveBeenCalledTimes(1);
    expect(mockDb.$queryRaw).toHaveBeenCalled();
    expect(mockDb.zoomMeeting.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a partner-produced webinar before Zoom is asked", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      timezone: "Asia/Dubai",
      eventType: "WEBINAR",
      settings: { webinar: { sessionId: "s1", source: "external" } },
    });
    expect(await create()).toMatchObject({ code: "EXTERNAL_VIDEO_SOURCE" });
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
    expect(mockDb.zoomMeeting.create).not.toHaveBeenCalled();
  });

  it("refuses a session that holds a partner's stream key before Zoom is asked", async () => {
    mockDb.externalStream.findFirst.mockResolvedValue({ id: "x1" });
    expect(await create()).toMatchObject({ code: "PARTNER_STREAM_EXISTS" });
    expect(mockZoom.createZoomWebinar).not.toHaveBeenCalled();
  });

  it("a key issued while Zoom was creating the meeting wins: the meeting is torn down, no row written", async () => {
    mockDb.externalStream.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "x1" });
    expect(await create()).toMatchObject({ code: "PARTNER_STREAM_EXISTS" });
    expect(mockDb.zoomMeeting.create).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledWith(expect.objectContaining({ zoomMeetingId: "777", organizationId: "org1" }));
  });
});
