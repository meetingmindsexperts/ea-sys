import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { apiLogger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

// Strict allowlists to prevent command injection
const ALLOWED_SINCE = new Set(["10m", "30m", "1h", "6h", "24h", "all"]);
const ALLOWED_LEVELS = new Set(["all", "error", "warn", "info", "debug"]);
const ALLOWED_SOURCES = new Set(["file", "docker"]);
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

async function readLogFile(
  level: string,
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

  // Take the last N lines
  const tailedLines = lines.slice(-tailNum);

  const logs = tailedLines
    .map(parsePinoLine)
    .filter((entry): entry is LogEntry => entry !== null);

  return { logs, source: `file (${logFileName})` };
}

async function readDockerLogs(
  since: string,
  tailNum: number
): Promise<{ logs: LogEntry[]; source: string }> {
  const args: string[] = ["logs"];

  if (since !== "all") {
    args.push("--since", since);
  }

  args.push(`--tail=${tailNum}`);
  args.push("--timestamps");
  args.push("ea-sys");

  const { stdout, stderr } = await execFileAsync("docker", args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  const rawOutput = stdout + (stderr || "");
  const logs = rawOutput
    .split("\n")
    .map(parseDockerLine)
    .filter((entry): entry is LogEntry => entry !== null);

  return { logs, source: "docker" };
}

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
    const level = searchParams.get("level") || "all";
    const since = searchParams.get("since") || "1h";
    const search = searchParams.get("search") || "";
    const tailParam = searchParams.get("tail") || "500";
    const sourceParam = searchParams.get("source") || "file";

    // Validate inputs against allowlists
    if (!ALLOWED_SINCE.has(since)) {
      return NextResponse.json(
        {
          error:
            "Invalid 'since' parameter. Allowed: 10m, 30m, 1h, 6h, 24h, all",
        },
        { status: 400 }
      );
    }

    if (!ALLOWED_LEVELS.has(level)) {
      return NextResponse.json(
        {
          error:
            "Invalid 'level' parameter. Allowed: all, error, warn, info, debug",
        },
        { status: 400 }
      );
    }

    if (!ALLOWED_SOURCES.has(sourceParam)) {
      return NextResponse.json(
        { error: "Invalid 'source' parameter. Allowed: file, docker" },
        { status: 400 }
      );
    }

    const tailNum = parseInt(tailParam, 10);
    if (isNaN(tailNum) || tailNum < 1 || tailNum > MAX_TAIL) {
      return NextResponse.json(
        {
          error: `Invalid 'tail' parameter. Must be a number between 1 and ${MAX_TAIL}`,
        },
        { status: 400 }
      );
    }

    let logs: LogEntry[];
    let source: string;

    if (sourceParam === "docker") {
      // Docker source — uses read-only socket
      try {
        const result = await readDockerLogs(since, tailNum);
        logs = result.logs;
        source = result.source;
      } catch (dockerError) {
        apiLogger.warn({ err: dockerError, msg: "Docker logs unavailable" });
        return NextResponse.json({
          error:
            "Docker not available. Try source=file or use SSH on EC2.",
          logs: [],
          count: 0,
        });
      }
    } else {
      // File source (default) — reads from logs/ directory
      const result = await readLogFile(level, tailNum);
      logs = result.logs;
      source = result.source;
    }

    // Filter by level if specified (file source for error already pre-filters)
    if (level !== "all" && sourceParam !== "file") {
      logs = logs.filter((log) => log.level === level);
    } else if (
      level !== "all" &&
      level !== "error" &&
      sourceParam === "file"
    ) {
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
