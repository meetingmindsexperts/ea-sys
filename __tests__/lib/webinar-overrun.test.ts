/**
 * Is a webinar still on air past its scheduled end (Nov 5, 2026)? Its own HLS stream arriving, or
 * missing for less than the grace; never in Zoom embed mode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const { mockDb, streamArrivingSpy } = vi.hoisted(() => ({
  mockDb: { zoomMeeting: { findFirst: vi.fn() } },
  streamArrivingSpy: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/webinar/stream-probe", () => ({ isStreamArriving: streamArrivingSpy }));

import { isWebinarStreamArriving, resetStreamAbsence, STREAM_ABSENCE_GRACE_MS } from "@/lib/webinar/overrun";

const hls = { webinar: { sessionId: "s1", viewingMode: "hls" } };
const call = (now: number, eventSettings: unknown = hls) =>
  isWebinarStreamArriving({ eventId: "ev1", sessionId: "s1", eventSettings, now });

beforeEach(() => {
  vi.clearAllMocks();
  resetStreamAbsence();
  mockDb.zoomMeeting.findFirst.mockResolvedValue({ liveStreamEnabled: true, streamKey: "sk-1" });
  streamArrivingSpy.mockResolvedValue(true);
});

describe("isWebinarStreamArriving", () => {
  it("Zoom embed mode has no stream to go by: false, and nothing is probed", async () => {
    expect(await call(0, { webinar: { sessionId: "s1", viewingMode: "zoom" } })).toBe(false);
    expect(streamArrivingSpy).not.toHaveBeenCalled();
  });

  it("a session without a configured stream: false", async () => {
    mockDb.zoomMeeting.findFirst.mockResolvedValue({ liveStreamEnabled: false, streamKey: "sk-1" });
    expect(await call(0)).toBe(false);
    mockDb.zoomMeeting.findFirst.mockResolvedValue(null);
    expect(await call(0)).toBe(false);
  });

  it("an arriving stream is on air, probed fresh", async () => {
    expect(await call(0)).toBe(true);
    expect(streamArrivingSpy).toHaveBeenCalledWith("sk-1", { fresh: true });
  });

  it("one missed probe is not the end; missing past the grace is", async () => {
    streamArrivingSpy.mockResolvedValue(false);
    expect(await call(0)).toBe(true);
    expect(await call(STREAM_ABSENCE_GRACE_MS - 1)).toBe(true);
    expect(await call(STREAM_ABSENCE_GRACE_MS)).toBe(false);
  });
});

describe("the worker can reach MediaMTX (review of fb4459d0, HIGH)", () => {
  it("docker-compose.prod.yml gives the worker MEDIAMTX_HLS_URL, or every probe hits its own localhost", () => {
    const compose = readFileSync(path.join(process.cwd(), "docker-compose.prod.yml"), "utf8");
    const worker = compose.slice(compose.indexOf("\n  ea-sys-worker:"), compose.indexOf("\n  mediamtx:"));
    expect(worker).toContain("- MEDIAMTX_HLS_URL=http://ea-sys-mediamtx:8888");
    expect(worker).toMatch(/networks:\s*\n\s*- web/);
  });
});

describe("MediaMTX's own log reaches CloudWatch (Nov 5, 2026)", () => {
  // Why a stream dropped is only in MediaMTX's lines. Three files must agree, or nothing ships.
  const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
  it("MediaMTX writes /logs/mediamtx.log, compose mounts ./logs there, and the agent ships that file", () => {
    expect(read("mediamtx.yml")).toMatch(/logDestinations: \[stdout, file\]/);
    expect(read("mediamtx.yml")).toContain("logFile: /logs/mediamtx.log");
    const compose = read("docker-compose.prod.yml");
    const mediamtx = compose.slice(compose.indexOf("\n  mediamtx:"));
    expect(mediamtx).toContain("- ./logs:/logs");
    const agent = JSON.parse(read("infra/cloudwatch/amazon-cloudwatch-agent.json"));
    const entry = agent.logs.logs_collected.files.collect_list.find(
      (f: { file_path: string }) => f.file_path === "/home/ubuntu/ea-sys/logs/mediamtx.log",
    );
    expect(entry?.log_group_name).toBe("ea-sys/mediamtx");
  });
});
