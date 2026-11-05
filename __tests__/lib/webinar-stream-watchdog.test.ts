/**
 * Stream watchdog (Nov 5, 2026): a live webinar's custom stream that drops while the room is open is
 * started again in Zoom, the way a producer did by hand on the Nov 5 test webinar. Plus the review of
 * 439b4d8e: re-check the room before acting, act only on a real 404, stop when Zoom says the webinar is
 * not running, never sleep for a room that does not need it, a reopened room is a new run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbOperator, mockDb, probeSpy, controlSpy } = vi.hoisted(() => ({
  mockDbOperator: { eventSession: { findMany: vi.fn() } },
  mockDb: {
    auditLog: { create: vi.fn(), findMany: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    zoomMeeting: { findFirst: vi.fn() },
  },
  probeSpy: vi.fn(),
  controlSpy: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDbOperator }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/webinar/stream-probe", () => ({ probeStream: probeSpy }));
vi.mock("@/lib/webinar/livestream", () => ({ controlWebinarLiveStream: controlSpy }));

import { apiLogger } from "@/lib/logger";
import { CONFIRM_DELAY_MS, MAX_AUTO_RESTARTS, resetStreamWatchdog, runStreamWatchdogTick } from "@/lib/webinar/stream-watchdog";

const OPENED = "2026-11-05T08:38:22.000Z";
const webinarSettings = (extra: Record<string, unknown> = {}) => ({
  webinar: { sessionId: "s1", viewingMode: "hls", roomOpenedAt: OPENED, ...extra },
});
const room = (extra: Record<string, unknown> = {}) => ({
  id: "s1",
  name: "Webinar",
  eventId: "ev1",
  event: { organizationId: "org1", slug: "web", settings: webinarSettings(extra) },
  zoomMeeting: { streamKey: "sk-1" },
});
const kinds = () => mockDb.auditLog.create.mock.calls.map((c) => (c[0] as { data: { changes: { kind: string } } }).data.changes.kind);

let clock = 0;
const sleeps: number[] = [];
const tick = () =>
  runStreamWatchdogTick({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamWatchdog();
  sleeps.length = 0;
  clock = Date.parse("2026-11-05T08:40:00Z");
  mockDbOperator.eventSession.findMany.mockResolvedValue([room()]);
  mockDb.auditLog.findMany.mockResolvedValue([]);
  mockDb.auditLog.create.mockResolvedValue({});
  // The re-check before acting sees the room unchanged.
  mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE" });
  mockDb.event.findFirst.mockResolvedValue({ settings: webinarSettings() });
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ streamKey: "sk-1" });
  controlSpy.mockResolvedValue({ ok: true, action: "start", streamKey: "sk-1" });
});

/** Seen live once, then every probe says `then`. */
async function liveThen(then: "absent" | "unknown" | "live") {
  probeSpy.mockResolvedValue("live");
  await tick();
  probeSpy.mockResolvedValue(then);
}

describe("runStreamWatchdogTick", () => {
  it("records the stream live once, not on every tick, and never waits", async () => {
    probeSpy.mockResolvedValue("live");
    await tick();
    await tick();
    expect(kinds()).toEqual(["STREAM_LIVE"]);
    expect(controlSpy).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("a drop (absent twice, a confirm wait apart) is logged at warn, timed, and Zoom is asked to start again", async () => {
    await liveThen("absent");
    const r = await tick();
    expect(sleeps).toEqual([CONFIRM_DELAY_MS]);
    expect(r).toMatchObject({ dropped: 1, restartsRequested: 1 });
    expect(kinds()).toEqual(["STREAM_LIVE", "STREAM_DROPPED", "AUTO_RESTART_REQUESTED"]);
    expect(controlSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "start", sessionId: "s1", eventId: "ev1", expectNotLive: true }),
    );
    expect(apiLogger.warn).toHaveBeenCalledWith(expect.anything(), "webinar-stream:dropped-while-live");
  });

  it("the confirm wait is under the worker's 25 s shutdown drain", () => {
    expect(CONFIRM_DELAY_MS).toBeLessThan(25_000);
  });

  it("a blip shorter than the second look is not a drop", async () => {
    await liveThen("live");
    probeSpy.mockResolvedValueOnce("absent").mockResolvedValueOnce("live");
    expect((await tick()).dropped).toBe(0);
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("an unreachable or slow MediaMTX is never a drop (review M2)", async () => {
    await liveThen("unknown");
    expect((await tick()).dropped).toBe(0);
    probeSpy.mockResolvedValueOnce("absent").mockResolvedValueOnce("unknown");
    expect((await tick()).dropped).toBe(0);
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("the room is read again before acting: a Stop, a close or a reopen during the wait wins (review H1)", async () => {
    const cases: Array<() => void> = [
      () => mockDb.event.findFirst.mockResolvedValue({ settings: webinarSettings({ streamStoppedAt: "2026-11-05T08:40:10Z" }) }),
      () => mockDb.eventSession.findFirst.mockResolvedValue({ status: "COMPLETED" }),
      () => mockDb.event.findFirst.mockResolvedValue({ settings: webinarSettings({ roomOpenedAt: "2026-11-05T08:40:15.000Z" }) }),
      () => mockDb.zoomMeeting.findFirst.mockResolvedValue({ streamKey: "sk-2" }),
      () => mockDb.event.findFirst.mockResolvedValue({ settings: webinarSettings({ viewingMode: "zoom" }) }),
    ];
    for (const change of cases) {
      resetStreamWatchdog();
      mockDb.event.findFirst.mockResolvedValue({ settings: webinarSettings() });
      mockDb.eventSession.findFirst.mockResolvedValue({ status: "LIVE" });
      mockDb.zoomMeeting.findFirst.mockResolvedValue({ streamKey: "sk-1" });
      controlSpy.mockClear();
      await liveThen("absent");
      change();
      await tick();
      expect(controlSpy).not.toHaveBeenCalled();
    }
  });

  it("a producer's Start or Stop recorded during the wait wins too", async () => {
    await liveThen("absent");
    // lastStreamObservation and runBoundarySince both read the timeline; the re-check finds a Stop.
    mockDb.auditLog.findMany.mockImplementation(async (args: { where: { createdAt?: { gte?: Date } } }) =>
      args.where.createdAt?.gte?.getTime() === clock ? [{ changes: { kind: "STREAM_STOP_PRESSED" } }] : [],
    );
    await tick();
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("Zoom answering 'not running' (the host ended) stops the attempts for that drop at once (review M1)", async () => {
    await liveThen("absent");
    controlSpy.mockResolvedValue({ ok: false, code: "NOT_LIVE_IN_ZOOM", message: "The webinar is not running in Zoom." });
    for (let i = 0; i < 30; i++) {
      await tick();
      clock += 60_000;
    }
    expect(controlSpy).toHaveBeenCalledTimes(1);
    expect(kinds()).toEqual(["STREAM_LIVE", "STREAM_DROPPED", "AUTO_RESTART_FAILED"]);
    // And once out of attempts it no longer waits on every tick.
    expect(sleeps).toHaveLength(1);
  });

  it("other refusals back off (1, 2, 4 ... minutes) and stop after the limit", async () => {
    await liveThen("absent");
    controlSpy.mockResolvedValue({ ok: false, code: "ZOOM_API_FAILED", message: "Zoom error" });
    for (let i = 0; i < 60; i++) {
      await tick();
      clock += 60_000;
    }
    expect(controlSpy).toHaveBeenCalledTimes(MAX_AUTO_RESTARTS);
    expect(kinds().filter((k) => k === "AUTO_RESTART_FAILED")).toHaveLength(MAX_AUTO_RESTARTS);
    expect(kinds().filter((k) => k === "STREAM_DROPPED")).toHaveLength(1);
  });

  it("the stream coming back is recorded as live again, and the restart count resets", async () => {
    await liveThen("absent");
    await tick();
    probeSpy.mockResolvedValue("live");
    await tick();
    expect(kinds()).toEqual(["STREAM_LIVE", "STREAM_DROPPED", "AUTO_RESTART_REQUESTED", "STREAM_LIVE"]);
  });

  it("a stream never live in this run is not a drop, is not started, and costs no wait (review M3)", async () => {
    probeSpy.mockResolvedValue("absent");
    await tick();
    expect(kinds()).toEqual([]);
    expect(controlSpy).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it("a reopened room is a new run: the old run's 'live' does not make its slow start a drop (review L1)", async () => {
    await liveThen("absent");
    mockDbOperator.eventSession.findMany.mockResolvedValue([room({ roomOpenedAt: "2026-11-05T08:45:00.000Z" })]);
    await tick();
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("after a worker restart it picks up from the timeline, attempts already spent included (review L2)", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([
      { changes: { kind: "AUTO_RESTART_FAILED" } },
      { changes: { kind: "AUTO_RESTART_FAILED" } },
      { changes: { kind: "AUTO_RESTART_FAILED" } },
      { changes: { kind: "AUTO_RESTART_FAILED" } },
      { changes: { kind: "AUTO_RESTART_FAILED" } },
      { changes: { kind: "STREAM_DROPPED" } },
    ]);
    probeSpy.mockResolvedValue("absent");
    await tick();
    expect(controlSpy).not.toHaveBeenCalled();
  });

  it("a producer's Start after an old 'live' starts a fresh run: not a drop", async () => {
    mockDb.auditLog.findMany.mockResolvedValue([{ changes: { kind: "STREAM_START_PRESSED" } }, { changes: { kind: "STREAM_LIVE" } }]);
    probeSpy.mockResolvedValue("absent");
    expect((await tick()).dropped).toBe(0);
  });

  it("leaves alone a stream the producer stopped on purpose, Zoom embed mode, and non-anchor sessions", async () => {
    probeSpy.mockResolvedValue("absent");
    mockDbOperator.eventSession.findMany.mockResolvedValue([
      room({ streamStoppedAt: "2026-11-05T08:50:00Z" }),
      room({ viewingMode: "zoom" }),
      { ...room(), event: { ...room().event, settings: { webinar: { sessionId: "other", viewingMode: "hls" } } } },
    ]);
    const r = await tick();
    expect(r.checked).toBe(0);
    expect(probeSpy).not.toHaveBeenCalled();
  });
});
