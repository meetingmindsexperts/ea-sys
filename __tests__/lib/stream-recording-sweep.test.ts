/**
 * The minute sweep behind recording a partner's stream (Nov 24, 2026;
 * docs/PARTNER_STREAM_RECORDING_PLAN.md). This file only pins WHICH recordings
 * it looks at and how: across organisations in the privileged lane, each one
 * then worked in its own tenant, from a fresh read (the service's
 * keepRecordingInStep, tested with the service).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { operator, lanes, keepSpy, configured, mockLogger } = vi.hoisted(() => ({
  operator: { streamRecording: { findMany: vi.fn() } },
  lanes: [] as string[],
  keepSpy: vi.fn(),
  configured: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ dbOperator: operator }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: async (org: string, fn: () => Promise<unknown>) => {
    lanes.push(org);
    return fn();
  },
}));
vi.mock("@/lib/webinar/mediamtx-control", () => ({ isMediamtxControlConfigured: configured }));
vi.mock("@/services/stream-recording-service", () => ({ keepRecordingInStep: keepSpy }));

import { convergeStreamRecordings, SWEEP_BUDGET_MS } from "@/lib/webinar/stream-recording-sweep";

const NOW = new Date("2026-12-01T09:00:00Z");
const rec = (n: number, organizationId: string | null = `org${n}`) => ({ eventId: `ev${n}`, sessionId: `s${n}`, organizationId });

beforeEach(() => {
  vi.clearAllMocks();
  lanes.length = 0;
  configured.mockReturnValue(true);
  operator.streamRecording.findMany.mockResolvedValue([]);
  keepSpy.mockResolvedValue("unchanged");
});

describe("convergeStreamRecordings", () => {
  it("looks at every open recording, and every closed one whose setting is not yet confirmed removed", async () => {
    await convergeStreamRecordings(NOW);
    const arg = operator.streamRecording.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      OR: [
        { status: { in: ["RECORDING", "PAUSED"] } },
        { status: { in: ["FINISHING", "READY", "FAILED"] }, serverClearedAt: null },
      ],
    });
    // No window of time: a clear that keeps failing is retried for as long as it takes (review of 7563027f7).
    expect(JSON.stringify(arg.where)).not.toContain("finishedAt");
    expect(arg.take).toBe(200);
  });

  it("takes nothing but the address of each recording from its own list: the state is read afresh by the service", async () => {
    await convergeStreamRecordings(NOW);
    expect(operator.streamRecording.findMany.mock.calls[0][0].select).toEqual({ eventId: true, sessionId: true, organizationId: true });
  });

  it("works each recording inside its own organisation, and counts what was done", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2), rec(3)]);
    keepSpy.mockResolvedValueOnce("corrected").mockResolvedValueOnce("closed").mockResolvedValueOnce("unchanged");
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 3, corrected: 1, closed: 1 });
    expect(lanes).toEqual(["org1", "org2", "org3"]);
    expect(keepSpy.mock.calls[0]).toEqual([rec(1), NOW, true]);
  });

  it("with no stream server to talk to it still runs, so an overrun recording is closed", async () => {
    configured.mockReturnValue(false);
    operator.streamRecording.findMany.mockResolvedValue([rec(1)]);
    await convergeStreamRecordings(NOW);
    expect(keepSpy).toHaveBeenCalledWith(rec(1), NOW, false);
  });

  it("one recording's failure never stops the others, and is logged with which it was", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2)]);
    keepSpy.mockRejectedValueOnce(new Error("lookup failed")).mockResolvedValueOnce("corrected");
    expect(await convergeStreamRecordings(NOW)).toEqual({ checked: 2, corrected: 1, closed: 0 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "stream-recording-sweep:recording-failed");
  });

  it("stops starting new work when its time is up, says how many wait, and leaves them to the next minute", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2), rec(3)]);
    // The clock: the start, then before each recording. The slow first one uses up the time.
    const times = [0, 0, SWEEP_BUDGET_MS, SWEEP_BUDGET_MS];
    const clock = () => times.shift() ?? SWEEP_BUDGET_MS;
    expect(await convergeStreamRecordings(NOW, { clock })).toEqual({ checked: 1, corrected: 0, closed: 0 });
    expect(keepSpy).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith({ checked: 1, waiting: 2 }, "stream-recording-sweep:out-of-time");
  });

  it("a recording with no organisation on it is still worked, outside any lane", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1, null)]);
    await convergeStreamRecordings(NOW);
    expect(lanes).toEqual([]);
    expect(keepSpy).toHaveBeenCalledTimes(1);
  });
});
