import pino, { multistream } from "pino";
import { Writable } from "stream";
import { join } from "path";
import { accessSync, constants, mkdirSync } from "fs";

const isDevelopment = process.env.NODE_ENV === "development";
const isVercel = !!process.env.VERCEL;
const isMcpStdio = !!process.env.MCP_STDIO_MODE;

const loggerConfig: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),

  serializers: {
    err: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: {
        host: req.headers?.host,
        "user-agent": req.headers?.["user-agent"],
      },
    }),
    res: (res) => ({ statusCode: res.statusCode }),
  },

  redact: {
    paths: [
      "password",
      "passwordHash",
      "token",
      "accessToken",
      "refreshToken",
      "authorization",
      "cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },

  base: {
    env: process.env.NODE_ENV,
    app: "ea-sys",
  },

  timestamp: pino.stdTimeFunctions.isoTime,
};

/**
 * Check if a directory exists and is writable by the current process.
 * Ensures the directory exists (creates it if needed) before checking write permission.
 */
function isDirWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Database Log Stream (for Vercel — no writable filesystem) ─────
// Writes log entries to SystemLog table via Prisma. Fire-and-forget
// async writes so logging never blocks the request.

function pinoLevelToString(level: number): string {
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  return "debug";
}

function createDbLogStream(): Writable {
  // Lazy-import Prisma to avoid circular dependency (db.ts imports logger.ts indirectly)
  let prisma: ReturnType<typeof getPrisma> | null = null;
  function getPrisma() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/db").db;
  }

  const buffer: { level: string; module: string; message: string; timestamp: Date }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    flushTimer = null;
    if (buffer.length === 0) return;
    const entries = buffer.splice(0);
    try {
      if (!prisma) prisma = getPrisma();
      await prisma.systemLog.createMany({
        data: entries.map((e) => ({
          level: e.level,
          module: e.module,
          message: e.message,
          timestamp: e.timestamp,
        })),
      });
    } catch {
      // Silently fail — don't let log persistence break the app
    }
  }

  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const line = chunk.toString().trim();
      if (!line) { callback(); return; }

      try {
        const entry = JSON.parse(line);
        const level = pinoLevelToString(entry.level ?? 30);
        // Only persist info+ (skip debug to reduce DB load)
        if (level === "debug") { callback(); return; }

        buffer.push({
          level,
          module: entry.module || "app",
          message: line,
          timestamp: entry.time ? new Date(entry.time) : new Date(),
        });

        // Batch flush every 2 seconds or when buffer hits 20 entries
        if (buffer.length >= 20) {
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, 2000);
        }
      } catch {
        // Not JSON, skip
      }
      callback();
    },
  });
}

// Development: pretty-print to console + write JSON to log files (for /logs viewer)
// Production on Vercel: plain pino → stdout only (no writable filesystem in serverless)
// Production on EC2/Docker: pino.multistream → stdout + logs/app.log + logs/error.log
function initLogger(): pino.Logger {
  // MCP stdio mode: stdout is reserved for MCP protocol — all logs go to stderr
  if (isMcpStdio) {
    return pino(loggerConfig, pino.destination({ dest: 2, sync: false })); // fd 2 = stderr
  }

  if (isDevelopment) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pinoPretty = require("pino-pretty");
    const prettyStream = pinoPretty.default({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname,env,app",
      singleLine: false,
      sync: true,
    });

    // Also write JSON to log files so the /logs viewer works in dev
    const logsDir = join(process.cwd(), "logs");
    if (isDirWritable(logsDir)) {
      const appDest = pino.destination({ dest: join(logsDir, "app.log"), mkdir: true, sync: false });
      const errDest = pino.destination({ dest: join(logsDir, "error.log"), mkdir: true, sync: false });
      const onStreamError = (err: Error) => {
        console.error(`[logger] file stream error: ${err.message}`);
      };
      appDest.on("error", onStreamError);
      errDest.on("error", onStreamError);

      return pino(
        loggerConfig,
        multistream([
          { stream: prettyStream },
          { stream: appDest },
          { level: "error", stream: errDest },
        ])
      );
    }

    // Fallback: pretty-print only (no writable logs dir)
    return pino(loggerConfig, prettyStream);
  }

  if (isVercel) {
    // Vercel: stdout (for Vercel's built-in logs) + database (for /logs viewer)
    const dbStream = createDbLogStream();
    return pino(
      loggerConfig,
      multistream([
        { stream: process.stdout },
        { level: "info", stream: dbStream },
      ])
    );
  }

  // EC2/Docker: write to stdout + file logs (fall back to stdout-only if files not writable)
  // Pre-check writability synchronously to avoid uncaught async errors from sonic-boom
  const logsDir = join(process.cwd(), "logs");
  if (!isDirWritable(logsDir)) {
    console.warn(`[logger] logs directory not writable (${logsDir}), falling back to stdout-only`);
    return pino(loggerConfig);
  }

  const appDest = pino.destination({ dest: join(logsDir, "app.log"), mkdir: true, sync: false });
  const errDest = pino.destination({ dest: join(logsDir, "error.log"), mkdir: true, sync: false });

  // Attach error handlers to prevent uncaught exceptions from sonic-boom async open
  const onStreamError = (err: Error) => {
    console.error(`[logger] file stream error: ${err.message}`);
  };
  appDest.on("error", onStreamError);
  errDest.on("error", onStreamError);

  return pino(
    loggerConfig,
    multistream([
      { stream: process.stdout },
      { stream: appDest },
      { level: "error", stream: errDest },
    ])
  );
}

export const logger = initLogger();

export const createLogger = (module: string) => logger.child({ module });

export const dbLogger   = createLogger("database");
export const authLogger = createLogger("auth");
export const apiLogger  = createLogger("api");
export const eventLogger = createLogger("events");

export const logApiRequest = (
  method: string,
  path: string,
  userId?: string,
  organizationId?: string
) => {
  apiLogger.info({ msg: `${method} ${path}`, method, path, userId, organizationId });
};

export const logApiError = (
  method: string,
  path: string,
  error: unknown,
  userId?: string
) => {
  apiLogger.error({
    msg: `API Error: ${method} ${path}`,
    method,
    path,
    userId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
};

export const logDbOperation = (operation: string, model: string, duration?: number) => {
  dbLogger.debug({
    msg: `DB ${operation} on ${model}`,
    operation,
    model,
    duration: duration ? `${duration}ms` : undefined,
  });
};

export const logAuthEvent = (
  event: "login" | "logout" | "register" | "failed_login",
  email?: string,
  userId?: string
) => {
  const logFn = event === "failed_login" ? authLogger.warn.bind(authLogger) : authLogger.info.bind(authLogger);
  logFn({ msg: `Auth event: ${event}`, event, email, userId });
};

export default logger;
