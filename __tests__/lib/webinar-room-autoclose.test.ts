/**
 * Webinar room auto-close (Oct 1, 2026): the room closes when Zoom reports
 * the webinar ended after the room opened, or two hours past the scheduled
 * end. An earlier practice run of the same Zoom webinar must never close it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbOperator, mockDb, getLastZoomEndTimeSpy, retimeSpy, streamArrivingSpy } = vi.hoisted(() => ({
  mockDbOperator: { eventSession: { findMany: vi.fn() } },
  mockDb: { eventSession: { updateMany: vi.fn() }, externalStream: { findFirst: vi.fn(), updateMany: vi.fn() }, zoomMeeting: { findFirst: vi.fn() } },
  getLastZoomEndTimeSpy: vi.fn(),
  retimeSpy: vi.fn(),
  streamArrivingSpy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/zoom/reports", () => ({ getLastZoomEndTime: getLastZoomEndTimeSpy }));
vi.mock("@/lib/webinar-email-sequence", () => ({ retimeThankYouAfterRoomClose: retimeSpy }));
vi.mock("@/lib/webinar/stream-probe", () => ({
  probeStream: async (key: string) => ((await streamArrivingSpy(key, { fresh: true })) ? "live" : "absent"),
}));

import { decideRoomClose, runWebinarRoomAutoCloseTick, SAFETY_NET_MS } from "@/lib/webinar/room-autoclose";
import { resetStreamAbsence } from "@/lib/webinar/overrun";

describe("decideRoomClose", () => {
  const start = new Date("2026-10-01T10:30:00Z");
  const end = new Date("2026-10-01T11:30:00Z");
  const opened = new Date("2026-10-01T10:28:00Z");

  it("closes when Zoom ended near or after the scheduled end, after the room opened, 5+ minutes ago", () => {
    expect(
      decideRoomClose({ now: new Date("2026-10-01T11:30:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: new Date("2026-10-01T11:20:00Z") }),
    ).toBe("close-zoom-ended");
  });

  it("keeps the room for a fresh end (the host may be restarting)", () => {
    expect(
      decideRoomClose({ now: new Date("2026-10-01T11:22:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: new Date("2026-10-01T11:20:00Z") }),
    ).toBe("keep");
  });

  it("keeps the room for an end well before the scheduled end (crash or mistaken End, then restart)", () => {
    expect(
      decideRoomClose({ now: new Date("2026-10-01T10:40:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: new Date("2026-10-01T10:20:00Z") }),
    ).toBe("keep");
  });

  it("a re-opened old room is not closed by the safety net within minutes", () => {
    const reopened = new Date(end.getTime() + 5 * 60 * 60 * 1000);
    expect(
      decideRoomClose({ now: new Date(reopened.getTime() + 10 * 60 * 1000), scheduledStart: start, scheduledEnd: end, roomOpenedAt: reopened, zoomEndedAt: null }),
    ).toBe("keep");
    expect(
      decideRoomClose({ now: new Date(reopened.getTime() + SAFETY_NET_MS + 60_000), scheduledStart: start, scheduledEnd: end, roomOpenedAt: reopened, zoomEndedAt: null }),
    ).toBe("close-safety-net");
  });

  it("keeps the room when Zoom's last end is an earlier practice run", () => {
    expect(
      decideRoomClose({ now: new Date("2026-10-01T10:40:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: new Date("2026-09-30T15:00:00Z") }),
    ).toBe("keep");
  });

  it("keeps the room while Zoom has no end (running) within the window, even past the scheduled end", () => {
    expect(
      decideRoomClose({ now: new Date("2026-10-01T12:00:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: null }),
    ).toBe("keep");
  });

  it("safety net: closes two hours after the scheduled end regardless", () => {
    expect(
      decideRoomClose({ now: new Date(end.getTime() + SAFETY_NET_MS + 60_000), scheduledStart: start, scheduledEnd: end, roomOpenedAt: opened, zoomEndedAt: null }),
    ).toBe("close-safety-net");
  });

  it("without a recorded open time, yesterday's practice run never counts", () => {
    const base = { now: new Date("2026-10-01T11:40:00Z"), scheduledStart: start, scheduledEnd: end, roomOpenedAt: null };
    expect(decideRoomClose({ ...base, zoomEndedAt: new Date("2026-10-01T11:25:00Z") })).toBe("close-zoom-ended");
    expect(decideRoomClose({ ...base, zoomEndedAt: new Date("2026-09-30T11:25:00Z") })).toBe("keep");
  });
});

describe("runWebinarRoomAutoCloseTick", () => {
  const room = (overrides: Record<string, unknown> = {}) => ({
    id: "s1",
    eventId: "ev1",
    startTime: new Date("2026-10-01T10:30:00Z"),
    endTime: new Date("2026-10-01T11:30:00Z"),
    event: { organizationId: "org1", settings: { webinar: { sessionId: "s1", roomOpenedAt: "2026-10-01T10:28:00Z" } } },
    zoomMeeting: { zoomMeetingId: "999", meetingType: "WEBINAR" },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.eventSession.updateMany.mockResolvedValue({ count: 1 });
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ liveStreamEnabled: true, streamKey: "sk-1" });
    streamArrivingSpy.mockResolvedValue(false);
    getLastZoomEndTimeSpy.mockResolvedValue(null);
    resetStreamAbsence();
  });

  const hlsRoom = () =>
    room({
      event: { organizationId: "org1", settings: { webinar: { sessionId: "s1", viewingMode: "hls", roomOpenedAt: "2026-10-01T10:28:00Z" } } },
    });

  it("a long overrun still on air keeps its room past the safety net (Nov 5, 2026)", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    streamArrivingSpy.mockResolvedValue(true);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"));
    expect(r.closed).toBe(0);
    expect(mockDb.eventSession.updateMany).not.toHaveBeenCalled();
    expect(streamArrivingSpy).toHaveBeenCalledWith("sk-1", { fresh: true });
  });

  it("the safety net closes an HLS room only once its stream has been gone five minutes, not on one missed probe", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    // First miss: grace starts, the room stays (an RTMP reconnect takes ~40 s).
    expect((await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"))).closed).toBe(0);
    expect((await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:03:00Z"))).closed).toBe(0);
    expect((await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:06:00Z"))).closed).toBe(1);
  });

  it("a stream that comes back inside the grace clears it", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"));
    streamArrivingSpy.mockResolvedValueOnce(true);
    await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:03:00Z"));
    // Missing again: a fresh grace, not the old one.
    expect((await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:06:00Z"))).closed).toBe(0);
  });

  it("past the safety net, a final Zoom end closes the room even while something still streams (an OBS loop)", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    streamArrivingSpy.mockResolvedValue(true);
    getLastZoomEndTimeSpy.mockResolvedValue(new Date("2026-10-01T13:40:00Z"));
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"));
    expect(r.closed).toBe(1);
    // The thank-you follows Zoom's real end.
    expect(retimeSpy).toHaveBeenCalledWith("ev1", new Date("2026-10-01T13:40:00Z"));
  });

  it("a Zoom end only minutes old (the host may restart) keeps an on-air room", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    streamArrivingSpy.mockResolvedValue(true);
    getLastZoomEndTimeSpy.mockResolvedValue(new Date("2026-10-01T13:58:00Z"));
    expect((await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"))).closed).toBe(0);
  });

  it("past the overrun hard cap it closes even with the stream arriving", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([hlsRoom()]);
    streamArrivingSpy.mockResolvedValue(true);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T17:31:00Z"));
    expect(r.closed).toBe(1);
  });

  it("Zoom embed mode never probes a stream: the plain safety net applies", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([room()]);
    streamArrivingSpy.mockResolvedValue(true);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"));
    expect(r.closed).toBe(1);
    expect(streamArrivingSpy).not.toHaveBeenCalled();
  });

  it("closes the anchor room Zoom reports ended, guarded on LIVE", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([room()]);
    getLastZoomEndTimeSpy.mockResolvedValue(new Date("2026-10-01T11:25:00Z"));
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T11:35:00Z"));
    expect(r).toEqual({ checked: 1, closed: 1, failed: 0 });
    expect(mockDb.eventSession.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", eventId: "ev1", status: "LIVE" },
      data: { status: "COMPLETED" },
    });
    // The thank-you follows Zoom's real end, not the tick time (Oct 28, 2026).
    expect(retimeSpy).toHaveBeenCalledWith("ev1", new Date("2026-10-01T11:25:00Z"));
  });

  it("ignores live sessions that are not the event's anchor room", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([room({ id: "other" })]);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T11:00:00Z"));
    expect(r.checked).toBe(0);
    expect(getLastZoomEndTimeSpy).not.toHaveBeenCalled();
  });

  it("past the safety net it closes without asking Zoom", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([room()]);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T14:00:00Z"));
    expect(r.closed).toBe(1);
    expect(getLastZoomEndTimeSpy).not.toHaveBeenCalled();
    // No Zoom end to go by, so the thank-you follows the close itself.
    expect(retimeSpy).toHaveBeenCalledWith("ev1", new Date("2026-10-01T14:00:00Z"));
  });

  it("a Zoom failure on one room is counted and does not stop the tick", async () => {
    mockDbOperator.eventSession.findMany.mockResolvedValue([room(), room({ id: "s2", eventId: "ev2", event: { organizationId: "org1", settings: { webinar: { sessionId: "s2" } } } })]);
    getLastZoomEndTimeSpy.mockRejectedValueOnce(new Error("Zoom API error: 500")).mockResolvedValueOnce(null);
    const r = await runWebinarRoomAutoCloseTick(new Date("2026-10-01T11:00:00Z"));
    expect(r).toEqual({ checked: 2, closed: 0, failed: 1 });
  });
});

