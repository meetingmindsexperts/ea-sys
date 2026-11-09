/**
 * Event DELETE removes the event's meetings from Zoom. The cascade deletes the
 * ZoomMeeting rows, the only record of what exists on Zoom, so before this a
 * deleted event left its webinar live there (owner report, Nov 9, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, teardown, order, logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockDb: {
    event: { findFirst: vi.fn(), delete: vi.fn() },
    invoice: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    dtcmOrder: { count: vi.fn().mockResolvedValue(0) },
    zoomMeeting: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  teardown: vi.fn(),
  order: [] as string[],
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: teardown }));

import { DELETE } from "@/app/api/events/[eventId]/route";

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const upcoming = { status: "SCHEDULED", endTime: FUTURE };
const params = Promise.resolve({ eventId: "ev1" });
const delReq = () => new Request("http://localhost/api/events/ev1?confirm=true", { method: "DELETE" });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ORGANIZER", organizationId: "org1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "Test Event" });
  mockDb.event.delete.mockImplementation(async () => {
    order.push("local");
    return {};
  });
  mockDb.invoice.count.mockResolvedValue(0);
  mockDb.payment.count.mockResolvedValue(0);
  mockDb.dtcmOrder.count.mockResolvedValue(0);
  mockDb.zoomMeeting.findMany.mockResolvedValue([
    { zoomMeetingId: "111", meetingType: "WEBINAR", session: upcoming },
    { zoomMeetingId: "222", meetingType: "MEETING", session: upcoming },
  ]);
  teardown.mockImplementation(async () => {
    order.push("zoom");
    return true;
  });
});

describe("event DELETE: Zoom teardown", () => {
  it("removes upcoming meetings from Zoom, after the local delete, and audits the outcome", async () => {
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1" } }),
    );
    expect(teardown).toHaveBeenCalledWith({ organizationId: "org1", meetingType: "WEBINAR", zoomMeetingId: "111", reason: "event-delete" });
    expect(teardown).toHaveBeenCalledWith({ organizationId: "org1", meetingType: "MEETING", zoomMeetingId: "222", reason: "event-delete" });
    expect(order).toEqual(["local", "zoom", "zoom"]);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ zoom: { removed: ["111", "222"], notRemoved: [], keptFinished: [] } }),
        }),
      }),
    );
  });

  it("leaves Zoom alone when the local delete fails", async () => {
    mockDb.event.delete.mockRejectedValue(new Error("db down"));
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(500);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("leaves Zoom alone when a financial guard blocks the delete", async () => {
    mockDb.invoice.count.mockResolvedValue(1);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(409);
    expect(mockDb.event.delete).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("when Zoom refuses: still 200, names the id to the UI, logs an error, audits it", async () => {
    teardown.mockResolvedValue(false);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, zoomNotRemoved: ["111", "222"] });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "zoom:orphaned-remote-meeting-needs-manual-cleanup", eventId: "ev1", zoomNotRemoved: ["111", "222"] }),
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ zoom: { removed: [], notRemoved: ["111", "222"], keptFinished: [] } }),
        }),
      }),
    );
  });

  it("logs the ids before the local delete, since nothing else holds them after it", async () => {
    mockDb.event.delete.mockRejectedValue(new Error("db down"));
    await DELETE(delReq(), { params });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "event-delete:zoom-meetings", toRemove: ["111", "222"] }),
    );
  });

  it.each([
    ["its end has passed", { status: "SCHEDULED", endTime: PAST }],
    ["it is COMPLETED, even if ended early", { status: "COMPLETED", endTime: FUTURE }],
  ])("keeps a finished webinar on Zoom: %s", async (_label, finished) => {
    mockDb.zoomMeeting.findMany.mockResolvedValue([
      { zoomMeetingId: "old", meetingType: "WEBINAR", session: finished },
      { zoomMeetingId: "new", meetingType: "WEBINAR", session: upcoming },
    ]);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith(expect.objectContaining({ zoomMeetingId: "new" }));
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ zoom: { removed: ["new"], notRemoved: [], keptFinished: ["old"] } }),
        }),
      }),
    );
  });

  it("a cancelled webinar still to come leaves Zoom", async () => {
    mockDb.zoomMeeting.findMany.mockResolvedValue([
      { zoomMeetingId: "c", meetingType: "WEBINAR", session: { status: "CANCELLED", endTime: FUTURE } },
    ]);
    await DELETE(delReq(), { params });
    expect(teardown).toHaveBeenCalledWith(expect.objectContaining({ zoomMeetingId: "c" }));
  });

  it.each([
    ["within its time", FUTURE],
    ["overrunning its end", PAST],
  ])("refuses (409) while a session is live, %s, and deletes nothing", async (_label, endTime) => {
    mockDb.zoomMeeting.findMany.mockResolvedValue([
      { zoomMeetingId: "live", meetingType: "WEBINAR", session: { status: "LIVE", endTime } },
    ]);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EVENT_SESSION_LIVE");
    expect(mockDb.event.delete).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "DELETE_BLOCKED" }) }),
    );
  });

  it("a failed Zoom read keeps the event: 500 and no delete", async () => {
    mockDb.zoomMeeting.findMany.mockRejectedValue(new Error("db down"));
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(500);
    expect(mockDb.event.delete).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("an event with no Zoom meetings makes no Zoom call", async () => {
    mockDb.zoomMeeting.findMany.mockResolvedValue([]);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(teardown).not.toHaveBeenCalled();
  });
});
