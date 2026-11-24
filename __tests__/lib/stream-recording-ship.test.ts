/**
 * The worker's shipping run (Nov 24, 2026; docs/PARTNER_STREAM_RECORDING_PLAN.md
 * §4.2): which recordings it ships, in which lane, and within what time. The
 * shipping itself is tested with the service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { operator, lanes, shipSpy, mockLogger } = vi.hoisted(() => ({
  operator: { streamRecording: { findMany: vi.fn() } },
  lanes: [] as string[],
  shipSpy: vi.fn(),
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
vi.mock("@/services/stream-recording-shipping", () => ({ shipRecordingPieces: shipSpy }));

import { SHIP_BUDGET_MS, shipStreamRecordings } from "@/lib/webinar/stream-recording-ship";

const NOW = new Date("2026-11-24T09:30:00Z");
const rec = (n: number, organizationId: string | null = `org${n}`) => ({ eventId: `ev${n}`, sessionId: `s${n}`, organizationId });

beforeEach(() => {
  vi.clearAllMocks();
  lanes.length = 0;
  operator.streamRecording.findMany.mockResolvedValue([]);
  shipSpy.mockResolvedValue({ shipped: 0, discarded: 0, waiting: 0 });
});

describe("shipStreamRecordings", () => {
  it("ships recordings that are recording, stopped for now, or finishing: never READY or FAILED", async () => {
    await shipStreamRecordings(NOW);
    const arg = operator.streamRecording.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ status: { in: ["RECORDING", "PAUSED", "FINISHING"] } });
    expect(arg.select).toEqual({ eventId: true, sessionId: true, organizationId: true });
    expect(arg.orderBy).toEqual({ lastStartedAt: "desc" });
  });

  it("works each recording inside its own organisation, and adds up what was done", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2)]);
    shipSpy.mockResolvedValueOnce({ shipped: 3, discarded: 1, waiting: 0 }).mockResolvedValueOnce({ shipped: 2, discarded: 0, waiting: 4 });
    expect(await shipStreamRecordings(NOW)).toEqual({ recordings: 2, shipped: 5, discarded: 1, waiting: 4 });
    expect(lanes).toEqual(["org1", "org2"]);
    expect(shipSpy.mock.calls[0][0]).toEqual(rec(1));
    expect(shipSpy.mock.calls[0][1]).toMatchObject({ now: NOW });
  });

  it("gives every recording the same deadline, twenty seconds from the start", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1)]);
    await shipStreamRecordings(NOW, { clock: () => 1000 });
    expect(shipSpy.mock.calls[0][1].deadline).toBe(1000 + SHIP_BUDGET_MS);
    expect(SHIP_BUDGET_MS).toBe(20_000);
  });

  it("stops starting recordings when the time is up, and says how many were left", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2), rec(3)]);
    const times = [0, 0, SHIP_BUDGET_MS];
    const clock = () => times.shift() ?? SHIP_BUDGET_MS;
    expect(await shipStreamRecordings(NOW, { clock })).toMatchObject({ recordings: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith({ recordings: 1, left: 2 }, "stream-recording-ship:out-of-time");
  });

  it("one recording's failure never stops the others, and is logged with which it was", async () => {
    operator.streamRecording.findMany.mockResolvedValue([rec(1), rec(2)]);
    shipSpy.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ shipped: 1, discarded: 0, waiting: 0 });
    expect(await shipStreamRecordings(NOW)).toMatchObject({ recordings: 2, shipped: 1 });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), "stream-recording-ship:recording-failed");
  });
});
