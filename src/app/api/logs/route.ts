import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { apiLogger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

const isVercel = !!process.env.VERCEL;

// Strict allowlists to prevent command injection
const ALLOWED_SINCE = new Set(["10m", "30m", "1h", "6h", "24h", "all"]);
const ALLOWED_LEVELS = new Set(["all", "error", "warn", "info", "debug"]);
const ALLOWED_SOURCES = new Set(["file", "docker", "database"]);
const MAX_TAIL = 2000;

type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
};

function parsePinoLine(line: string): LogEntry | null {
  if (!line.trim()) return null;

  try {
    const jsonLog = JSON.parse(line);
    let logLevel = "info";
    if (jsonLog.level >= 50) logLevel = "error";
    else if (jsonLog.level >= 40) logLevel = "warn";
    else if (jsonLog.level >= 30) logLevel = "info";
    else logLevel = "debug";

    return {
      timestamp: jsonLog.time
        ? new Date(jsonLog.time).toISOString()
        : new Date().toISOString(),
      level: logLevel,
      message: line,
    };
  } catch {
    // Not JSON — plain text line
    const lowerLine = line.toLowerCase();
    let logLevel = "info";
    if (lowerLine.includes("error") || lowerLine.includes("fatal")) {
      logLevel = "error";
    } else if (lowerLine.includes("warn")) {
      logLevel = "warn";
    }

    return {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message: line,
    };
  }
}

function parseDockerLine(line: string): LogEntry | null {
  if (!line.trim()) return null;

  // Docker log format: 2026-02-19T10:30:45.123456789Z log message
  const timestampMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/
  );

  if (timestampMatch) {
    const timestamp = timestampMatch[1];
    const message = timestampMatch[2];

    let logLevel = "info";
    try {
      const jsonLog = JSON.parse(message);
      if (jsonLog.level) {
        if (jsonLog.level >= 50) logLevel = "error";
        else if (jsonLog.level >= 40) logLevel = "warn";
        else if (jsonLog.level >= 30) logLevel = "info";
        else logLevel = "debug";
      }
    } catch {
      const lowerMessage = message.toLowerCase();
      if (lowerMessage.includes("error") || lowerMessage.includes("fatal")) {
        logLevel = "error";
      } else if (lowerMessage.includes("warn")) {
        logLevel = "warn";
      }
    }

    return { timestamp, level: logLevel, message };
  }

  return { timestamp: new Date().toISOString(), level: "info", message: line };
}

// ── Time range to Date offset ───────────────────────────────────────
function sinceToDate(since: string): Date | null {
  const now = Date.now();
  switch (since) {
    case "10m": return new Date(now - 10 * 60 * 1000);
    case "30m": return new Date(now - 30 * 60 * 1000);
    case "1h":  return new Date(now - 60 * 60 * 1000);
    case "6h":  return new Date(now - 6 * 60 * 60 * 1000);
    case "24h": return new Date(now - 24 * 60 * 60 * 1000);
    default:    return null; // "all"
  }
}

// ── Database source (works on Vercel) ───────────────────────────────
async function readDatabaseLogs(
  level: string,
  since: string,
  tailNum: number
): Promise<{ logs: LogEntry[]; source: string }> {
  const sinceDate = sinceToDate(since);

  const where: Record<string, unknown> = {};
  if (level !== "all") {
    where.level = level;
  }
  if (sinceDate) {
    where.timestamp = { gte: sinceDate };
  }

  const rows = await db.systemLog.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: tailNum,
    select: { level: true, message: true, timestamp: true },
  });

  const logs: LogEntry[] = rows.reverse().map((row) => ({
    timestamp: row.timestamp.toISOString(),
    level: row.level,
    message: row.message,
  }));

  return { logs, source: "database" };
}

async function readLogFile(
  level: string,
  since: string,
  tailNum: number
): Promise<{ logs: LogEntry[]; source: string }> {
  // Use error log file for error-only filter, otherwise app log
  const logFileName = level === "error" ? "error.log" : "app.log";
  const logPath = join(process.cwd(), "logs", logFileName);

  try {
    await stat(logPath);
  } catch {
    return { logs: [], source: "file (not found)" };
  }

  const content = await readFile(logPath, "utf-8");
  const lines = content.split("\n");

  // Take the last N lines (over-fetch to account for filtering)
  const tailedLines = lines.slice(-(tailNum * 3));

  let logs = tailedLines
    .map(parsePinoLine)
    .filter((entry): entry is LogEntry => entry !== null);

  // Apply time range filter
  const sinceDate = sinceToDate(since);
  if (sinceDate) {
    const sinceMs = sinceDate.getTime();
    logs = logs.filter((log) => new Date(log.timestamp).getTime() >= sinceMs);
  }

  // Apply level filter (error.log is already pre-filtered for errors)
  if (level !== "all" && level !== "error") {
    logs = logs.filter((log) => log.level === level);
  }

  // Trim to requested tail count
  if (logs.length > tailNum) {
    logs = logs.slice(-tailNum);
  }

  return { logs, source: `file (${logFileName})` };
}

// ── Detect running container name for docker logs ─────────────────
async function getContainerName(): Promise<string> {
  // Try reading the hostname inside a Docker container (container ID)
  try {
    const hostname = (await readFile("/etc/hostname", "utf-8")).trim();
    if (hostname) {
      // Get the container name from the container ID
      const { stdout } = await execFileAsync(
        "docker",
        ["inspect", "--format", "{{.Name}}", hostname],
        { timeout: 5000 }
      );
      const name = stdout.trim().replace(/^\//, "");
      if (name) return name;
    }
  } catch {
    // Not inside Docker or can't inspect
  }

  // Fallback: find a running container matching our project
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.Names}}", "--filter", "name=ea-sys"],
      { timeout: 5000 }
    );
    const containers = stdout.trim().split("\n").filter(Boolean);
    if (containers.length > 0) return containers[0];
  } catch {
    // Docker not available
  }

  // Last resort
  return "ea-sys-blue";
}

async function readDockerLogs(
  since: string,
  tailNum: number
): Promise<{ logs: LogEntry[]; source: string }> {
  const containerName = await getContainerName();
  const args: string[] = ["logs"];

  if (since !== "all") {
    args.push("--since", since);
  }

  args.push(`--tail=${tailNum}`);
  args.push("--timestamps");
  args.push(containerName);

  const { stdout, stderr } = await execFileAsync("docker", args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  // Docker outputs app stdout to stdout and app stderr to stderr
  const rawOutput = (stdout || "") + (stderr || "");
  const logs = rawOutput
    .split("\n")
    .map(parseDockerLine)
    .filter((entry): entry is LogEntry => entry !== null);

  return { logs, source: `docker (${containerName})` };
}

// ── DELETE: Clear logs for a specific timeframe ──────────────────────
export async function DELETE(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const since = searchParams.get("since") || "24h";
    const sourceParam = searchParams.get("source") || "database";

    if (!ALLOWED_SINCE.has(since)) {
      return NextResponse.json({ error: "Invalid 'since' parameter" }, { status: 400 });
    }

    if (sourceParam !== "database") {
      return NextResponse.json({ error: "Clear is only supported for database logs" }, { status: 400 });
    }

    const sinceDate = sinceToDate(since);
    const where: Record<string, unknown> = {};
    if (sinceDate) {
      where.timestamp = { gte: sinceDate };
    }

    const result = await db.systemLog.deleteMany({ where });

    apiLogger.info({ msg: "Logs cleared", since, deletedCount: result.count, userId: session.user.id });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to clear logs" });
    return NextResponse.json({ error: "Failed to clear logs" }, { status: 500 });
  }
}

// ── GET: Fetch logs ──────────────────────────────────────────────────
export async function GET(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only SUPER_ADMIN can access logs
    if (session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json(
        { error: "Forbidden. Only super admins can access system logs." },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const level = searchParams.get("level") || "error";
    const since = searchParams.get("since") || "10m";
    const search = searchParams.get("search") || "";
    const tailParam = searchParams.get("tail") || "500";
    // Default to "database" on Vercel (no filesystem), "file" elsewhere
    const sourceParam = searchParams.get("source") || (isVercel ? "database" : "file");

    // Validate inputs against allowlists
    if (!ALLOWED_SINCE.has(since)) {
      return NextResponse.json(
        { error: "Invalid 'since' parameter. Allowed: 10m, 30m, 1h, 6h, 24h, all" },
        { status: 400 }
      );
    }

    if (!ALLOWED_LEVELS.has(level)) {
      return NextResponse.json(
        { error: "Invalid 'level' parameter. Allowed: all, error, warn, info, debug" },
        { status: 400 }
      );
    }

    if (!ALLOWED_SOURCES.has(sourceParam)) {
      return NextResponse.json(
        { error: "Invalid 'source' parameter. Allowed: file, docker, database" },
        { status: 400 }
      );
    }

    const tailNum = parseInt(tailParam, 10);
    if (isNaN(tailNum) || tailNum < 1 || tailNum > MAX_TAIL) {
      return NextResponse.json(
        { error: `Invalid 'tail' parameter. Must be a number between 1 and ${MAX_TAIL}` },
        { status: 400 }
      );
    }

    let logs: LogEntry[];
    let source: string;

    if (sourceParam === "database") {
      const result = await readDatabaseLogs(level, since, tailNum);
      logs = result.logs;
      source = result.source;
    } else if (sourceParam === "docker") {
      // Docker source — uses read-only socket
      try {
        const result = await readDockerLogs(since, tailNum);
        logs = result.logs;
        source = result.source;
      } catch (dockerError) {
        apiLogger.warn({ err: dockerError, msg: "Docker logs unavailable" });
        return NextResponse.json({
          error: "Docker not available. Try source=database or source=file.",
          logs: [],
          count: 0,
        });
      }
    } else {
      // File source — reads from logs/ directory (filters applied inside)
      const result = await readLogFile(level, since, tailNum);
      logs = result.logs;
      source = result.source;
    }

    // Docker source: apply level filter (Docker --since handles time, but not level)
    if (sourceParam === "docker" && level !== "all") {
      logs = logs.filter((log) => log.level === level);
    }

    // Filter by search term
    if (search) {
      const searchLower = search.toLowerCase();
      logs = logs.filter(
        (log) =>
          log.message.toLowerCase().includes(searchLower) ||
          log.timestamp.toLowerCase().includes(searchLower)
      );
    }

    return NextResponse.json({
      logs,
      count: logs.length,
      source,
      since,
      level,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Failed to fetch logs" });

    return NextResponse.json(
      {
        error: "Failed to fetch logs",
        logs: [],
        count: 0,
      },
      { status: 500 }
    );
  }
}
