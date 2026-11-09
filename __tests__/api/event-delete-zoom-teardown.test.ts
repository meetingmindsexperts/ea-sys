/**
 * Event DELETE removes the event's meetings from Zoom. The cascade deletes the
 * ZoomMeeting rows, the only record of what exists on Zoom, so before this a
 * deleted event left its webinar live there (owner report, Nov 9, 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, teardown, order } = vi.hoisted(() => ({
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
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/zoom/cleanup", () => ({ deleteRemoteZoomMeeting: teardown }));

import { DELETE } from "@/app/api/events/[eventId]/route";

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
    { zoomMeetingId: "111", meetingType: "WEBINAR" },
    { zoomMeetingId: "222", meetingType: "MEETING" },
  ]);
  teardown.mockImplementation(async () => {
    order.push("zoom");
    return true;
  });
});

describe("event DELETE: Zoom teardown", () => {
  it("removes every meeting from Zoom, after the local delete, and audits the ids", async () => {
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(mockDb.zoomMeeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1", organizationId: "org1" } }),
    );
    expect(teardown).toHaveBeenCalledWith({ organizationId: "org1", meetingType: "WEBINAR", zoomMeetingId: "111", reason: "event-delete" });
    expect(teardown).toHaveBeenCalledWith({ organizationId: "org1", meetingType: "MEETING", zoomMeetingId: "222", reason: "event-delete" });
    expect(order).toEqual(["local", "zoom", "zoom"]);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ zoomMeetingIds: ["111", "222"] }),
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

  it("still succeeds when Zoom refuses: the helper logs and returns false", async () => {
    teardown.mockResolvedValue(false);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
  });

  it("an event with no Zoom meetings makes no Zoom call", async () => {
    mockDb.zoomMeeting.findMany.mockResolvedValue([]);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(teardown).not.toHaveBeenCalled();
  });
});
