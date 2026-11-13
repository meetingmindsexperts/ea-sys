/**
 * `get_system_log_summary`: the platform operator's read of recent warnings
 * and errors, over MCP (Nov 13, 2026).
 *
 * WHY IT EXISTS. The owner runs a check of production's log every few hours.
 * From a laptop that is a read-only psql into production; from a cloud routine
 * there was no way in at all, because the log table is reachable only with
 * credentials that live on one machine. This tool is that way in, through the
 * connector the owner already signs in to.
 *
 * WHO GETS IT. The same wall as the /logs page, and nothing wider:
 * `canActAsPlatformOperator` (SUPER_ADMIN, and on the platform the operator
 * organisation). The log table is not tenant data: one table for the whole
 * deployment, with no organisation column. So:
 *   - it is registered ONLY on the HTTP MCP door, ONLY for an OAuth grant
 *     whose granting user is the operator;
 *   - NEVER for an API key, which belongs to one tenant and is refused the
 *     operator surface everywhere else (platform-operator.ts);
 *   - it is deliberately NOT part of `registerAllMcpTools`, so it is not in
 *     the shared tool registry, the in-app Event Agent never sees it, and it
 *     has no permission key a custom role could be given.
 * The check runs twice: when the server is built (the tool is not listed for
 * anyone else) and again inside the call.
 *
 * WHAT IT RETURNS. A summary, not the log: message names with counts and
 * times, and at most a few sample lines per message with email addresses and
 * phone numbers masked. Read-only; it cannot change or delete a log line.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { canActAsPlatformOperator } from "@/lib/platform-operator";

export const SYSTEM_LOG_SUMMARY_TOOL = "get_system_log_summary";

const MAX_HOURS = 72;
const DEFAULT_HOURS = 4;
const MAX_SAMPLES = 3;
/** Rows read per call. A quiet day is a few dozen; past this the answer says it was cut. */
export const MAX_LOG_ROWS = 5000;
const MAX_GROUPS = 60;
const MAX_SAMPLE_LENGTH = 600;

/** Keys that say where a line was written, never what happened. Dropped from samples. */
const NOISE_KEYS = ["hostname", "pid", "traceId", "time", "env", "app"];

export interface LogRow {
  level: string;
  message: string;
  timestamp: Date;
}

export interface LogGroup {
  level: string;
  /** The line's own name (`msg`), or its first characters when it is not JSON. */
  name: string;
  count: number;
  first: string;
  last: string;
  samples: string[];
}

export interface LogSummary {
  windowStart: string;
  windowEnd: string;
  totals: Record<string, number>;
  groups: LogGroup[];
  /** More rows matched than were read: the counts are of the newest `MAX_LOG_ROWS` only. */
  truncated: boolean;
  /** More distinct messages than are listed. */
  groupsOmitted: number;
}

/**
 * An email address or a phone number never leaves in a sample: the summary is
 * read by an assistant and may be written into a document. Names cannot be
 * recognised reliably, so samples are capped and short, and the caller is told
 * (in the tool's description) to copy ids and counts, not people.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => (match.replace(/\D/g, "").length >= 9 ? "[number]" : match));
}

/** A line's name: the `msg` of a JSON log line, else its first characters. */
export function logLineName(message: string): string {
  try {
    const parsed = JSON.parse(message) as { msg?: unknown };
    if (typeof parsed.msg === "string" && parsed.msg.trim()) return parsed.msg.slice(0, 120);
  } catch {
    // Not JSON: a plain line.
  }
  return maskPersonalData(message.slice(0, 120));
}

/** A sample as the operator reads it: without the where-it-ran keys, masked, and short. */
function sampleOf(message: string): string {
  let line = message;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    for (const key of NOISE_KEYS) delete parsed[key];
    line = JSON.stringify(parsed);
  } catch {
    // Not JSON: as it is.
  }
  return maskPersonalData(line).slice(0, MAX_SAMPLE_LENGTH);
}

/**
 * Rows (newest first) into the summary. Pure: the test hands it rows and the
 * tool hands it what the database returned.
 */
export function summariseLogRows(
  rows: readonly LogRow[],
  opts: { windowStart: Date; windowEnd: Date; samples: number; truncated: boolean },
): LogSummary {
  const totals: Record<string, number> = {};
  const groups = new Map<string, LogGroup>();
  for (const row of rows) {
    totals[row.level] = (totals[row.level] ?? 0) + 1;
    const name = logLineName(row.message);
    const key = `${row.level}\u0000${name}`;
    const at = row.timestamp.toISOString();
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { level: row.level, name, count: 1, first: at, last: at, samples: opts.samples > 0 ? [sampleOf(row.message)] : [] });
      continue;
    }
    group.count += 1;
    if (at < group.first) group.first = at;
    if (at > group.last) group.last = at;
    if (group.samples.length < opts.samples) group.samples.push(sampleOf(row.message));
  }
  // Errors first, then the most frequent.
  const ordered = [...groups.values()].sort((a, b) => Number(b.level === "error") - Number(a.level === "error") || b.count - a.count);
  return {
    windowStart: opts.windowStart.toISOString(),
    windowEnd: opts.windowEnd.toISOString(),
    totals,
    groups: ordered.slice(0, MAX_GROUPS),
    truncated: opts.truncated,
    groupsOmitted: Math.max(0, ordered.length - MAX_GROUPS),
  };
}

export interface OperatorToolCaller {
  /** The granting user's role on an OAuth grant; null for an API key. */
  role: string | null;
  fromApiKey: boolean;
  organizationId: string;
}

/** The one question: is this caller the platform operator, signed in as a person. */
export function mayReadSystemLog(caller: OperatorToolCaller): boolean {
  return !caller.fromApiKey && canActAsPlatformOperator({ role: caller.role, organizationId: caller.organizationId });
}

const INPUT = {
  hours: z.number().int().min(1).max(MAX_HOURS).optional().describe(`How far back to read, in hours (1 to ${MAX_HOURS}). Default ${DEFAULT_HOURS}.`),
  level: z.enum(["warn_and_error", "error", "all"]).optional().describe('Which lines: "warn_and_error" (default), "error" only, or "all" stored levels.'),
  samples: z.number().int().min(0).max(MAX_SAMPLES).optional().describe(`Sample lines per message, 0 to ${MAX_SAMPLES}. Default 1. Emails and phone numbers are masked.`),
  contains: z.string().trim().min(2).max(100).optional().describe("Only lines containing this text, for example a message name such as person-field."),
};

/**
 * Lists the tool on this server when, and only when, the caller is the
 * platform operator signed in as a person. Returns whether it was listed.
 */
export function registerOperatorLogTool(server: McpServer, caller: OperatorToolCaller): boolean {
  if (!mayReadSystemLog(caller)) return false;

  server.tool(
    SYSTEM_LOG_SUMMARY_TOOL,
    "Platform operator only. A read-only summary of the application's recent warnings and errors (the same log the /logs page shows): " +
      "each message name with its count, first and last time, and a few sample lines with emails and phone numbers masked. " +
      "Use it to check the health of the deployment. When recording what you find, copy message names, counts, times and ids; never a person's name.",
    INPUT,
    async (input) => {
      // The second wall: the listing above is not the authorisation.
      if (!mayReadSystemLog(caller)) {
        apiLogger.warn({ msg: "mcp:system-log-summary:refused", organizationId: caller.organizationId, role: caller.role, fromApiKey: caller.fromApiKey });
        return { content: [{ type: "text" as const, text: "Error: this tool is for the platform operator." }], isError: true };
      }
      try {
        const hours = input.hours ?? DEFAULT_HOURS;
        const windowEnd = new Date();
        const windowStart = new Date(windowEnd.getTime() - hours * 60 * 60 * 1000);
        const levels = levelsFor(input.level ?? "warn_and_error");
        const rows = await db.systemLog.findMany({
          where: {
            timestamp: { gte: windowStart },
            ...(levels && { level: { in: levels } }),
            ...(input.contains && { message: { contains: input.contains, mode: "insensitive" as const } }),
          },
          orderBy: { timestamp: "desc" },
          // One more than is used, to know whether the window held more.
          take: MAX_LOG_ROWS + 1,
          select: { level: true, message: true, timestamp: true },
        });
        const truncated = rows.length > MAX_LOG_ROWS;
        const summary = summariseLogRows(truncated ? rows.slice(0, MAX_LOG_ROWS) : rows, {
          windowStart,
          windowEnd,
          samples: input.samples ?? 1,
          truncated,
        });
        apiLogger.info({ msg: "mcp:system-log-summary", organizationId: caller.organizationId, hours, rows: rows.length, groups: summary.groups.length });
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        apiLogger.error({ err, msg: "mcp:system-log-summary:failed", organizationId: caller.organizationId });
        return { content: [{ type: "text" as const, text: "Error: the log could not be read." }], isError: true };
      }
    },
  );
  return true;
}

function levelsFor(choice: "warn_and_error" | "error" | "all"): string[] | null {
  if (choice === "error") return ["error"];
  if (choice === "all") return null;
  return ["warn", "error"];
}
