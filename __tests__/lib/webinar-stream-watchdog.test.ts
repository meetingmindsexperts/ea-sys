/**
 * Stream watchdog (Nov 5, 2026): a live webinar's custom stream that drops while the room is open is
 * started again in Zoom, the way a producer did by hand on the Nov 5 test webinar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbOperator, mockDb, probeSpy, controlSpy } = vi.hoisted(() => ({
  mockDbOperator: { eventSession: { findMany: vi.fn() } },
  mockDb: { auditLog: { create: vi.fn(), findMany: vi.fn() } },
  probeSpy: vi.fn(),
  controlSpy: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/webinar/stream-probe", () => ({ isStreamArriving: probeSpy }));
vi.mock("@/lib/webinar/livestream", () => ({ controlWebinarLiveStream: controlSpy }));

import { apiLogger } from "@/lib/logger";
import { MAX_AUTO_RESTARTS, resetStreamWatchdog, runStreamWatchdogTick } from "@/lib/webinar/stream-watchdog";

const room = (webinar: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "Webinar",
  eventId: "ev1",
  event: { organizationId: "org1", slug: "web", settings: { webinar: { sessionId: "s1", viewingMode: "hls", ...webinar } } },
  zoomMeeting: { streamKey: "sk-1" },
});
const kinds = () => mockDb.auditLog.create.mock.calls.map((c) => (c[0] as { data: { changes: { kind: string } } }).data.changes.kind);

let clock = 0;
const tick = () => runStreamWatchdogTick({ now: () => clock, sleep: async () => {} });

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamWatchdog();
  clock = 1_000_000;
  mockDbOperator.eventSession.findMany.mockResolvedValue([room()]);
  mockDb.auditLog.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
  controlSpy.mockResolvedValue({ ok: true, action: "start", streamKey: "sk-1" });
});

describe("runStreamWatchdogTick", () => {
  it("records the stream live once, not on every tick", async () => {
    probeSpy.mockResolvedValue(true);
    await tick();
    await tick();
    expect(kinds()).toEqual(["STREAM_LIVE"]);
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("a drop (missing twice, 30 s apart) is logged at warn, timed, and Zoom is asked to start again", async () => {
    probeSpy.mockResolvedValue(true);
    await tick();
    probeSpy.mockResolvedValue(false);
    const r = await tick();
    expect(r).toMatchObject({ dropped: 1, restartsRequested: 1 });
    expect(kinds()).toEqual(["STREAM_LIVE", "STREAM_DROPPED", "AUTO_RESTART_REQUESTED"]);
    expect(controlSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "start", sessionId: "s1", eventId: "ev1" }));
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.anything(), "webinar-stream:dropped-while-live");
  });

  it("a blip shorter than the second look is not a drop", async () => {
    probeSpy.mockResolvedValue(true);
    await tick();
    probeSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await tick()).dropped).toBe(0);
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("the stream coming back is recorded as live again, and the restart count resets", async () => {
    probeSpy.mockResolvedValue(true);
    await tick();
    probeSpy.mockResolvedValue(false);
    await tick();
    probeSpy.mockResolvedValue(true);
    await tick();
    expect(kinds()).toEqual(["STREAM_LIVE", "STREAM_DROPPED", "AUTO_RESTART_REQUESTED", "STREAM_LIVE"]);
  });

  it("restarts back off (1, 2, 4 ... minutes) and stop after the limit", async () => {
    probeSpy.mockResolvedValue(true);
    await tick();
    probeSpy.mockResolvedValue(false);
    controlSpy.mockResolvedValue({ ok: false, code: "ZOOM_API_FAILED", message: "The webinar has not started" });
    for (let i = 0; i < 60; i++) {
      await tick();
      clock += 60_000;
    }
    expect(controlSpy).toHaveBeenCalledTimes(MAX_AUTO_RESTARTS);
    expect(kinds().filter((k) => k === "AUTO_RESTART_FAILED")).toHaveLength(MAX_AUTO_RESTARTS);
    expect(kinds().filter((k) => k === "STREAM_DROPPED")).toHaveLength(1);
  });

  it("a stream never live in this room is not a drop and is not started", async () => {
    probeSpy.mockResolvedValue(false);
    await tick();
    expect(kinds()).toEqual([]);
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("after a worker restart it picks up from the timeline: last seen live means a missing stream is a drop", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([{ changes: { kind: "STREAM_LIVE" } }]);
    probeSpy.mockResolvedValue(false);
    expect((await tick()).dropped).toBe(1);
  });

  it("leaves alone a stream the producer stopped on purpose, Zoom embed mode, and non-anchor sessions", async () => {
    probeSpy.mockResolvedValue(false);
    mockDbOperator.eventSession.findMany.mockResolvedValue([
      room({ streamStoppedAt: "2026-11-05T08:50:00Z" }),
      room({ viewingMode: "zoom" }),
      room({ sessionId: "other" }),
    ]);
    const r = await tick();
    expect(r.checked).toBe(0);
    expect(probeSpy).not.toHaveBeenCalled();
  });
});
