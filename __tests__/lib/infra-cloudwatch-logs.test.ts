/**
 * The /logs viewer's CloudWatch source (W0-3, Nov 9, 2026), which replaced the
 * `docker logs`-through-the-host-socket source. What these pin:
 *
 * 1. The Insights query: the "error" level keeps Docker stderr and nginx's
 *    [error]/[crit] lines (a crash trace has no pino level, and it is the line
 *    this source exists for); pino's level matches both the raw and the
 *    Docker-escaped form; a search is a case-insensitive, regex-escaped match.
 * 2. A Docker json-file line is unwrapped to the container's own output with
 *    its service label, and plain stderr reads as an error.
 * 3. Results come back oldest-first like every other source; "all" is capped
 *    at 24 hours; the source label shows the bytes scanned; a query that outlives the wait is STOPPED and marked partial.
 * 4. A failed query throws, so the route answers with an error, not "no logs".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const send = vi.fn();

vi.mock("@aws-sdk/client-cloudwatch-logs", () => {
  const cmd = (kind: string) =>
    class {
      readonly kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    CloudWatchLogsClient: class { send = send; },
    StartQueryCommand: cmd("start"),
    GetQueryResultsCommand: cmd("results"),
    StopQueryCommand: cmd("stop"),
  };
});

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  buildInsightsQuery,
  toLogEntry,
  readCloudWatchLogs,
  resetCloudWatchLogsClient,
  isCloudWatchLogSource,
} from "@/lib/infra/cloudwatch-logs";

// Insights regexes are RE2-ish; JS regex is close enough for these patterns.
function insightsRegexes(query: string): RegExp[] {
  return [...query.matchAll(/like \/(.+?)\/(?= or |\s*\||$)/g)].map((m) => {
    const src = m[1].replace(/^\(\?i\)/, "");
    return new RegExp(src, m[1].startsWith("(?i)") ? "i" : "");
  });
}

const row = (ts: string, msg: string) => [
  { field: "@timestamp", value: ts },
  { field: "@message", value: msg },
];

describe("buildInsightsQuery", () => {
  it("error level matches pino 50 raw and Docker-escaped, Docker stderr and nginx [crit]", () => {
    const q = buildInsightsQuery("error", "", 500);
    const res = insightsRegexes(q);
    const matches = (line: string) => res.some((r) => r.test(line));
    expect(matches('{"level":50,"time":1,"msg":"x"}')).toBe(true);
    expect(matches('{"log":"{\\"level\\":60,\\"time\\":1}\\n","stream":"stdout"}')).toBe(true);
    expect(matches('{"log":"TypeError: boom\\n","stream":"stderr"}')).toBe(true);
    expect(matches("2026/11/09 05:00:00 [crit] 12#12: connect() failed")).toBe(true);
    expect(matches('{"level":30,"time":1,"msg":"ok"}')).toBe(false);
    expect(matches('{"log":"{\\"level\\":30}\\n","stream":"stdout"}')).toBe(false);
    expect(q).toMatch(/sort @timestamp desc \| limit 500$/);
  });

  it("level 'all' adds no level filter", () => {
    expect(buildInsightsQuery("all", "", 10)).toBe("fields @timestamp, @message | sort @timestamp desc | limit 10");
  });

  it("search is case-insensitive and regex-escaped (no injection through / or |)", () => {
    const q = buildInsightsQuery("all", "a/b|c.d", 10);
    expect(q).toContain("filter @message like /(?i)a\\/b\\|c\\.d/");
    const [r] = insightsRegexes(q);
    expect(r.test("xx A/B|C.D yy")).toBe(true);
    expect(r.test("a/bXc.d")).toBe(false);
  });
});

describe("toLogEntry", () => {
  it("unwraps a Docker line with its service label and pino level", () => {
    const raw = JSON.stringify({ log: '{"level":40,"msg":"slow"}\n', stream: "stdout", attrs: { ea_sys_service: "green" } });
    expect(toLogEntry("cloudwatch-docker", "t", raw)).toEqual({
      timestamp: "t",
      level: "warn",
      message: '[green] {"level":40,"msg":"slow"}',
    });
  });

  it("plain Docker stderr is an error, even without the word error", () => {
    const raw = JSON.stringify({ log: "    at Module._compile (node:internal)\n", stream: "stderr" });
    expect(toLogEntry("cloudwatch-docker", "t", raw)).toMatchObject({ level: "error", message: "[container]     at Module._compile (node:internal)" });
  });

  it("nginx lines take their bracketed level; app lines their pino level", () => {
    expect(toLogEntry("cloudwatch-nginx", "t", "2026/11/09 [warn] 1#1: x").level).toBe("warn");
    expect(toLogEntry("cloudwatch-app", "t", '{"level":50}').level).toBe("error");
  });
});

describe("readCloudWatchLogs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    resetCloudWatchLogsClient();
  });
  afterEach(() => vi.useRealTimers());

  it("allows only the three known sources", () => {
    expect(isCloudWatchLogSource("cloudwatch-docker")).toBe(true);
    expect(isCloudWatchLogSource("docker")).toBe(false);
    expect(isCloudWatchLogSource("toString")).toBe(false);
  });

  it("returns rows oldest-first, converts Insights time to ISO, caps 'all' at 24 hours and shows bytes scanned", async () => {
    send.mockImplementation(async (c: { kind: string }) => {
      if (c.kind === "start") return { queryId: "q1" };
      return {
        status: "Complete",
        statistics: { bytesScanned: 3 * 1_048_576 },
        results: [row("2026-11-09 05:00:02.000", '{"level":50}'), row("2026-11-09 05:00:01.000", '{"level":50}')],
      };
    });
    const p = readCloudWatchLogs("cloudwatch-app", { level: "error", search: "", tail: 50, sinceDate: null });
    await vi.runAllTimersAsync();
    const out = await p;

    expect(out.logs.map((l) => l.timestamp)).toEqual(["2026-11-09T05:00:01.000Z", "2026-11-09T05:00:02.000Z"]);
    expect(out.partial).toBe(false);
    expect(out.source).toBe("cloudwatch (ea-sys/app, last 24h, 3.0 MB scanned)");
    const start = send.mock.calls[0][0].input;
    expect(start.logGroupName).toBe("ea-sys/app");
    expect(start.endTime - start.startTime).toBeLessThanOrEqual(24 * 3600 + 1);
    expect(send.mock.calls.some(([c]) => c.kind === "stop")).toBe(false);
  });

  it("stops a query that outlives the wait and marks the answer partial", async () => {
    send.mockImplementation(async (c: { kind: string }) => {
      if (c.kind === "start") return { queryId: "q2" };
      if (c.kind === "stop") return {};
      return { status: "Running", results: [row("2026-11-09 05:00:00.000", "x")] };
    });
    const p = readCloudWatchLogs("cloudwatch-docker", {
      level: "all", search: "", tail: 10, sinceDate: new Date(Date.now() - 600_000),
    });
    await vi.runAllTimersAsync();
    const out = await p;

    expect(out.partial).toBe(true);
    expect(out.logs).toHaveLength(1);
    expect(out.source).toBe("cloudwatch (ea-sys/docker, 0.0 MB scanned, partial)");
    expect(send.mock.calls.filter(([c]) => c.kind === "stop")[0][0].input).toEqual({ queryId: "q2" });
  });

  it("containers at info level points to the app log, where those lines live", async () => {
    send.mockImplementation(async (c: { kind: string }) =>
      c.kind === "start" ? { queryId: "q4" } : { status: "Complete", results: [] },
    );
    const p = readCloudWatchLogs("cloudwatch-docker", { level: "info", search: "", tail: 10, sinceDate: new Date(Date.now() - 600_000) });
    await vi.runAllTimersAsync();
    expect((await p).source).toContain("info/debug are in CloudWatch: app log");
  });

  it("a group the agent has not created yet reads as empty with a hint; other start errors throw", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }));
    const out = await readCloudWatchLogs("cloudwatch-docker", { level: "all", search: "", tail: 10, sinceDate: null });
    expect(out.logs).toEqual([]);
    expect(out.source).toContain("not created yet");

    send.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(
      readCloudWatchLogs("cloudwatch-docker", { level: "all", search: "", tail: 10, sinceDate: null }),
    ).rejects.toThrow("denied");
  });

  it("a failed query throws instead of reading as 'no logs'", async () => {
    send.mockImplementation(async (c: { kind: string }) =>
      c.kind === "start" ? { queryId: "q3" } : { status: "Failed", results: [] },
    );
    const p = readCloudWatchLogs("cloudwatch-nginx", { level: "all", search: "", tail: 10, sinceDate: null });
    const assertion = expect(p).rejects.toThrow("CloudWatch query Failed");
    await vi.runAllTimersAsync();
    await assertion;
  });
});
