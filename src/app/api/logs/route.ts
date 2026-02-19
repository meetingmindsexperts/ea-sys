import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
    const level = searchParams.get("level") || "all"; // all, error, warn, info
    const since = searchParams.get("since") || "1h"; // 10m, 1h, 6h, 24h, all
    const search = searchParams.get("search") || "";
    const tail = searchParams.get("tail") || "500"; // number of lines

    // Build docker logs command
    let command = "docker logs";

    // Add time range if not "all"
    if (since !== "all") {
      command += ` --since ${since}`;
    }

    // Add tail limit
    command += ` --tail=${tail}`;

    // Add timestamps
    command += " --timestamps";

    // Container name
    command += " ea-sys";

    // Redirect stderr to stdout
    command += " 2>&1";

    // Execute command
    const { stdout } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    // Parse logs into structured format
    let logs = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        // Docker log format: 2026-02-19T10:30:45.123456789Z log message
        const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/);

        if (timestampMatch) {
          const timestamp = timestampMatch[1];
          const message = timestampMatch[2];

          // Try to parse as JSON (Pino logs)
          let logLevel = "info";
          let parsedMessage = message;

          try {
            const jsonLog = JSON.parse(message);
            if (jsonLog.level) {
              // Pino log levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
              if (jsonLog.level >= 50) logLevel = "error";
              else if (jsonLog.level >= 40) logLevel = "warn";
              else if (jsonLog.level >= 30) logLevel = "info";
              else logLevel = "debug";
            }
            parsedMessage = message; // Keep JSON for display
          } catch {
            // Not JSON, try to detect level from message
            const lowerMessage = message.toLowerCase();
            if (lowerMessage.includes("error") || lowerMessage.includes("fatal")) {
              logLevel = "error";
            } else if (lowerMessage.includes("warn")) {
              logLevel = "warn";
            }
            parsedMessage = message;
          }

          return {
            timestamp,
            level: logLevel,
            message: parsedMessage,
          };
        }

        // Fallback for lines without timestamp
        return {
          timestamp: new Date().toISOString(),
          level: "info",
          message: line,
        };
      });

    // Filter by level if specified
    if (level !== "all") {
      logs = logs.filter((log) => log.level === level);
    }

    // Filter by search term if specified
    if (search) {
      const searchLower = search.toLowerCase();
      logs = logs.filter((log) =>
        log.message.toLowerCase().includes(searchLower) ||
        log.timestamp.toLowerCase().includes(searchLower)
      );
    }

    return NextResponse.json({
      logs,
      count: logs.length,
      containerName: "ea-sys",
      since,
      level,
    });
  } catch (error) {
    console.error("Error fetching logs:", error);

    // Check if Docker is not available
    if (error instanceof Error && error.message.includes("docker")) {
      return NextResponse.json({
        error: "Docker not available. Logs can only be viewed on EC2 instance.",
        logs: [],
        count: 0,
      });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch logs",
        logs: [],
        count: 0,
      },
      { status: 500 }
    );
  }
}
