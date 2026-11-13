/**
 * `get_system_log_summary` (Nov 13, 2026): the platform operator's read of
 * recent warnings and errors over MCP. Two things are pinned here:
 *  - WHO gets it: the wall of the /logs page and nothing wider. The log table
 *    has no organisation column, so a tenant's API key, an admin, or a
 *    SUPER_ADMIN of the wrong organisation on the platform must never see the
 *    tool listed, and a call from one is refused even if it were;
 *  - WHAT leaves: message names, counts and times, with a few masked samples.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, logger } = vi.hoisted(() => ({
  mockDb: { systemLog: { findMany: vi.fn() } },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger, authLogger: logger, dbLogger: logger, eventLogger: logger }));

import {
  MAX_LOG_ROWS,
  SYSTEM_LOG_SUMMARY_TOOL,
  logLineName,
  maskPersonalData,
  mayReadSystemLog,
  registerOperatorLogTool,
  summariseLogRows,
  type LogSummary,
} from "@/lib/agent/operator-log-tool";
import { buildMcpServer } from "@/lib/agent/mcp-server-builder";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
type ToolCallback = (input: Record<string, unknown>) => Promise<ToolResult>;

/** A server that records what is listed on it, as tool-registry.ts does. */
function recordingServer() {
  const tools = new Map<string, ToolCallback>();
  const server = { tool: (...args: unknown[]) => tools.set(String(args[0]), args[args.length - 1] as ToolCallback) };
  return { server: server as never, tools };
}

const OPERATOR = { role: "SUPER_ADMIN", fromApiKey: false, organizationId: "org-1" };
const at = (iso: string) => new Date(iso);
const line = (fields: Record<string, unknown>) => JSON.stringify({ level: 40, time: 1, hostname: "box", pid: 7, traceId: "t", env: "production", app: "ea-sys", ...fields });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ORG_ID;
});
afterEach(() => {
  delete process.env.PLATFORM_ORG_ID;
});

describe("who may read the log", () => {
  it("the platform operator, signed in as a person", () => {
    expect(mayReadSystemLog(OPERATOR)).toBe(true);
  });

  it.each([
    ["an organisation admin", { ...OPERATOR, role: "ADMIN" }],
    ["an organiser", { ...OPERATOR, role: "ORGANIZER" }],
    ["an API key (no role)", { role: null, fromApiKey: true, organizationId: "org-1" }],
    ["an API key, even one that claims the operator's role", { ...OPERATOR, fromApiKey: true }],
    ["a grant whose user has no role", { ...OPERATOR, role: null }],
    ["a role nobody has heard of", { ...OPERATOR, role: "ROOT" }],
  ])("never %s", (_who, caller) => {
    expect(mayReadSystemLog(caller)).toBe(false);
    const { server, tools } = recordingServer();
    expect(registerOperatorLogTool(server, caller)).toBe(false);
    expect(tools.size).toBe(0);
  });

  it("on the platform, only the operator organisation's SUPER_ADMIN: a tenant's is refused", () => {
    process.env.PLATFORM_ORG_ID = "platform-org";
    expect(mayReadSystemLog(OPERATOR)).toBe(false);
    expect(mayReadSystemLog({ ...OPERATOR, organizationId: "platform-org" })).toBe(true);
  });

  it("the real MCP server lists the tool for the operator's grant and for nobody else", () => {
    const listed = (actor?: { role: string | null; fromApiKey: boolean }) => {
      const server = buildMcpServer("org-1", actor) as unknown as { _registeredTools: Record<string, unknown> };
      return SYSTEM_LOG_SUMMARY_TOOL in server._registeredTools;
    };
    expect(listed({ role: "SUPER_ADMIN", fromApiKey: false })).toBe(true);
    expect(listed({ role: "ADMIN", fromApiKey: false })).toBe(false);
    expect(listed({ role: "ORGANIZER", fromApiKey: false })).toBe(false);
    expect(listed({ role: null, fromApiKey: true })).toBe(false);
    // No actor at all is how an API key's server was always built.
    expect(listed(undefined)).toBe(false);
  });

  it("a call is refused, and logged, if the caller stops being the operator after the tool was listed", async () => {
    const { server, tools } = recordingServer();
    registerOperatorLogTool(server, OPERATOR);
    process.env.PLATFORM_ORG_ID = "platform-org";
    const result = await tools.get(SYSTEM_LOG_SUMMARY_TOOL)!({});
    expect(result.isError).toBe(true);
    expect(mockDb.systemLog.findMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "mcp:system-log-summary:refused" }));
  });
});

describe("what a call reads and answers", () => {
  const call = async (input: Record<string, unknown> = {}) => {
    const { server, tools } = recordingServer();
    registerOperatorLogTool(server, OPERATOR);
    return tools.get(SYSTEM_LOG_SUMMARY_TOOL)!(input);
  };

  it("reads warnings and errors of the last four hours by default, newest first, and nothing else", async () => {
    mockDb.systemLog.findMany.mockResolvedValue([]);
    const before = Date.now();
    await call();
    const args = mockDb.systemLog.findMany.mock.calls[0][0];
    expect(args.where.level).toEqual({ in: ["warn", "error"] });
    const since = (args.where.timestamp.gte as Date).getTime();
    expect(before - since).toBeGreaterThanOrEqual(4 * 3600_000 - 5);
    expect(before - since).toBeLessThan(4 * 3600_000 + 5_000);
    expect(args.orderBy).toEqual({ timestamp: "desc" });
    expect(args.take).toBe(MAX_LOG_ROWS + 1);
    expect(args.select).toEqual({ level: true, message: true, timestamp: true });
    expect(args.where).not.toHaveProperty("message");
  });

  it("takes the hours, the level and a text to look for", async () => {
    mockDb.systemLog.findMany.mockResolvedValue([]);
    await call({ hours: 24, level: "error", contains: "person-field" });
    const args = mockDb.systemLog.findMany.mock.calls[0][0];
    expect(args.where.level).toEqual({ in: ["error"] });
    expect(args.where.message).toEqual({ contains: "person-field", mode: "insensitive" });
    await call({ level: "all" });
    expect(mockDb.systemLog.findMany.mock.calls[1][0].where).not.toHaveProperty("level");
  });

  it("answers the summary as JSON and says when the window held more than it read", async () => {
    const row = { level: "warn", message: line({ msg: "dtcm-pool:empty" }), timestamp: at("2026-11-13T14:01:27Z") };
    mockDb.systemLog.findMany.mockResolvedValue(Array.from({ length: MAX_LOG_ROWS + 1 }, () => row));
    const result = await call();
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0].text) as LogSummary;
    expect(summary.truncated).toBe(true);
    expect(summary.totals).toEqual({ warn: MAX_LOG_ROWS });
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({ name: "dtcm-pool:empty", count: MAX_LOG_ROWS });
  });

  it("a database failure is an error result and a log line, never a throw and never the cause in the answer", async () => {
    mockDb.systemLog.findMany.mockRejectedValue(new Error("connection refused to 10.0.0.5"));
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("10.0.0.5");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "mcp:system-log-summary:failed" }));
  });
});

describe("the summary", () => {
  const opts = { windowStart: at("2026-11-13T10:00:00Z"), windowEnd: at("2026-11-13T14:00:00Z"), samples: 1, truncated: false };

  it("groups by level and message name, errors first, then the most frequent, with first and last time", () => {
    const rows = [
      { level: "warn", message: line({ msg: "dtcm-pool:empty", eventId: "ev1" }), timestamp: at("2026-11-13T13:00:00Z") },
      { level: "warn", message: line({ msg: "dtcm-pool:empty", eventId: "ev1" }), timestamp: at("2026-11-13T11:00:00Z") },
      { level: "warn", message: line({ msg: "event-loop:stall" }), timestamp: at("2026-11-13T12:00:00Z") },
      { level: "error", message: line({ msg: "Failed to send email" }), timestamp: at("2026-11-13T12:30:00Z") },
    ];
    const summary = summariseLogRows(rows, opts);
    expect(summary.totals).toEqual({ warn: 3, error: 1 });
    expect(summary.groups.map((g) => [g.level, g.name, g.count])).toEqual([
      ["error", "Failed to send email", 1],
      ["warn", "dtcm-pool:empty", 2],
      ["warn", "event-loop:stall", 1],
    ]);
    expect(summary.groups[1]).toMatchObject({ first: "2026-11-13T11:00:00.000Z", last: "2026-11-13T13:00:00.000Z" });
    expect(summary.groupsOmitted).toBe(0);
  });

  it("the same message at two levels is two groups", () => {
    const rows = [
      { level: "warn", message: line({ msg: "x" }), timestamp: at("2026-11-13T13:00:00Z") },
      { level: "error", message: line({ msg: "x" }), timestamp: at("2026-11-13T13:00:01Z") },
    ];
    expect(summariseLogRows(rows, opts).groups).toHaveLength(2);
  });

  it("a sample drops where the line was written and masks emails and phone numbers", () => {
    const message = line({ msg: "public/register:refused", email: "jane.doe@hospital.example", phone: "+971 50 123 4567", registrationId: "cmwf1p3ct0003mv0158iwist0", durationMs: 1178.6 });
    const [group] = summariseLogRows([{ level: "warn", message, timestamp: at("2026-11-13T13:00:00Z") }], opts).groups;
    const sample = group.samples[0];
    expect(sample).not.toContain("jane.doe");
    expect(sample).not.toContain("123 4567");
    expect(sample).toContain("[email]");
    expect(sample).toContain("[number]");
    // Ids and measurements are what the operator needs: kept.
    expect(sample).toContain("cmwf1p3ct0003mv0158iwist0");
    expect(sample).toContain("1178.6");
    for (const key of ["hostname", "pid", "traceId"]) expect(sample).not.toContain(`"${key}"`);
  });

  it("keeps at most the samples asked for, none when none is asked, and each is short", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ level: "warn", message: line({ msg: "same", n: i, pad: "x".repeat(2000) }), timestamp: at(`2026-11-13T13:0${i}:00Z`) }));
    expect(summariseLogRows(rows, { ...opts, samples: 2 }).groups[0].samples).toHaveLength(2);
    expect(summariseLogRows(rows, { ...opts, samples: 0 }).groups[0].samples).toEqual([]);
    expect(summariseLogRows(rows, { ...opts, samples: 1 }).groups[0].samples[0].length).toBeLessThanOrEqual(600);
  });

  it("a line that is not JSON is named by its first characters, masked", () => {
    expect(logLineName("Unhandled rejection for a@b.co at startup")).toBe("Unhandled rejection for [email] at startup");
    expect(logLineName(line({ msg: "walk-in:person-fields-refused" }))).toBe("walk-in:person-fields-refused");
    expect(logLineName(line({ note: "no msg here" }))).toContain("{");
  });

  it("lists at most sixty messages and says how many it left out", () => {
    const rows = Array.from({ length: 75 }, (_, i) => ({ level: "warn", message: line({ msg: `m-${i}` }), timestamp: at("2026-11-13T13:00:00Z") }));
    const summary = summariseLogRows(rows, opts);
    expect(summary.groups).toHaveLength(60);
    expect(summary.groupsOmitted).toBe(15);
  });

  it("masking leaves dates, short numbers and ids alone", () => {
    expect(maskPersonalData("on 2026-11-13 took 13200.4 ms for cmsdaeqa20002lr014qkqdmoc, serial 1042")).toBe("on 2026-11-13 took 13200.4 ms for cmsdaeqa20002lr014qkqdmoc, serial 1042");
    // A local number of nine digits is a phone number too; a short reference is not.
    expect(maskPersonalData("call 00971501234567 or (04) 123-4567, ref 12-3456")).toBe("call [number] or ([number], ref 12-3456");
  });
});
