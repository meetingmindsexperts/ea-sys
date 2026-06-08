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

/**
 * Forward an error log entry to Sentry on the server.
 * Lazy-imports @sentry/nextjs to avoid pulling Sentry into client bundles
 * (logger.ts is server-only but the lazy import keeps tree-shaking honest).
 */
function forwardToSentry(module: string, args: unknown[]): void {
  // Only run server-side; Sentry's client init lives elsewhere
  if (typeof window !== "undefined") return;

  // Best-effort, never block the log call on Sentry availability
  void (async () => {
    try {
      const Sentry = await import("@sentry/nextjs");
      const first = args[0];

      // Pino's error API: logger.error({ err, msg, ...ctx }, message?) or logger.error(error, message?)
      let error: unknown;
      let context: Record<string, unknown> = {};
      let message: string | undefined;

      if (first instanceof Error) {
        error = first;
        message = typeof args[1] === "string" ? args[1] : undefined;
      } else if (typeof first === "object" && first !== null) {
        const obj = first as Record<string, unknown>;
        error = obj.err ?? obj.error;
        message = typeof obj.msg === "string" ? obj.msg : (typeof args[1] === "string" ? args[1] : undefined);
        // Copy all other fields as context, redacting known sensitive keys
        const REDACTED_KEYS = new Set(["password", "passwordHash", "token", "accessToken", "refreshToken", "authorization", "cookie"]);
        for (const [k, v] of Object.entries(obj)) {
          if (k === "err" || k === "error" || k === "msg") continue;
          if (REDACTED_KEYS.has(k)) continue;
          context[k] = v;
        }
      } else if (typeof first === "string") {
        message = first;
        context = { args: args.slice(1) };
      }

      if (error instanceof Error) {
        Sentry.captureException(error, {
          tags: { module, source: "pino" },
          extra: { ...context, message },
        });
      } else {
        // No Error object — capture as a message
        Sentry.captureMessage(message || `${module} error`, {
          level: "error",
          tags: { module, source: "pino" },
          extra: { ...context, error },
        });
      }
    } catch {
      // Sentry forwarding must never break logging
    }
  })();
}

/**
 * Wraps a Pino child logger so that every .error() call also forwards
 * to Sentry as an exception capture. .warn(), .info(), etc. are untouched.
 */
function withSentryForwarding(child: pino.Logger, module: string): pino.Logger {
  const originalError = child.error.bind(child);
  child.error = ((...args: unknown[]) => {
    forwardToSentry(module, args);
    return (originalError as (...a: unknown[]) => void)(...args);
  }) as typeof child.error;
  return child;
}

/**
 * Patterns we DON'T fire admin-alert for, because another code path
 * already alerts on them with richer context (and we'd otherwise
 * double-alert per incident).
 *
 * Current entries:
 *   - "Failed to send email" — src/lib/email.ts sendEmail() catch
 *     already calls notifyAdminOfSendFailure with full AWS context
 *     (errorName, requestId, recipient, eventId, templateSlug).
 *     The generic logger hook would otherwise produce a sister
 *     alert with only module + msg.
 *   - "admin-alert:notify-failed" — already covered by the recursion
 *     guard inside admin-alert.ts (console.error, no apiLogger).
 *     Listed here as belt-and-braces in case the path ever changes.
 */
const ADMIN_ALERT_SKIP_PATTERNS: ReadonlyArray<RegExp> = [
  /^Failed to send email$/i,
  /^admin-alert:/i,
];

/**
 * Forward an error log entry to the admin-alert path. Same lazy-import
 * pattern as Sentry forwarding to break the email.ts ↔ logger.ts cycle
 * (admin-alert.ts lazy-imports email.ts internally).
 *
 * Dedup key shape: `logger:{module}:{msg-substring}` — keeps the same
 * (module, msg) combo to one alert per hour. Different modules emitting
 * the same msg are NOT collapsed (they're typically different root
 * causes); same module + same msg ARE collapsed because they're
 * effectively the same error fingerprint.
 */
function forwardToAdminAlert(module: string, args: unknown[]): void {
  if (typeof window !== "undefined") return; // server-only

  void (async () => {
    try {
      const first = args[0];
      let message: string | undefined;
      let errSignature: string | undefined;
      let detail: string | undefined;
      let context: Record<string, unknown> = {};

      if (first instanceof Error) {
        message = typeof args[1] === "string" ? args[1] : first.message;
        errSignature = first.name && first.name !== "Error" ? first.name : "Error";
      } else if (typeof first === "object" && first !== null) {
        const obj = first as Record<string, unknown>;
        message = typeof obj.msg === "string" ? obj.msg : (typeof args[1] === "string" ? args[1] : undefined);
        // Extract a stable signature for dedupe — prefer awsErrorName
        // when present, then err.name, then a generic "error" string.
        const errInner = obj.err ?? obj.error;
        if (errInner instanceof Error) {
          errSignature = errInner.name && errInner.name !== "Error" ? errInner.name : "Error";
        } else if (typeof obj.awsErrorName === "string") {
          errSignature = obj.awsErrorName;
        } else {
          errSignature = "error";
        }

        // Extract the underlying error TEXT for the email body's Detail
        // line. Originally we dropped both `err` and `error` from the
        // context block on the assumption their content was surfaced
        // elsewhere — turned out to be wrong for the Prisma case where
        // the structured `msg` field is a generic title ("Prisma error")
        // and `error: e.message` carries the real driver text. Without
        // this extraction the operator gets an alert that says "DB
        // module had an error" with no information about WHAT.
        //
        // Priority: err.message > error-as-string > err string form.
        // Trims + caps at 500 chars to keep the email scannable.
        if (errInner instanceof Error && errInner.message) {
          detail = errInner.message;
        } else if (typeof obj.error === "string" && obj.error.length > 0) {
          detail = obj.error;
        } else if (typeof obj.err === "string" && obj.err.length > 0) {
          detail = obj.err;
        }
        if (detail && detail.length > 500) detail = `${detail.slice(0, 500)}…`;

        // Capture the structured-log fields as alert context (redacting
        // the same sensitive keys Sentry does). Drop the err/error/msg
        // fields themselves — they're surfaced separately in the body
        // via message + detail + errSignature.
        const REDACTED_KEYS = new Set(["password", "passwordHash", "token", "accessToken", "refreshToken", "authorization", "cookie"]);
        for (const [k, v] of Object.entries(obj)) {
          if (k === "err" || k === "error" || k === "msg") continue;
          if (REDACTED_KEYS.has(k)) continue;
          context[k] = v;
        }
      } else if (typeof first === "string") {
        message = first;
        errSignature = "error";
        context = { args: args.slice(1) };
      }

      if (!message) return; // nothing to alert about

      // Skip alerts that have their own dedicated path.
      for (const pattern of ADMIN_ALERT_SKIP_PATTERNS) {
        if (pattern.test(message)) return;
      }

      const { notifyAdminAlert } = await import("./admin-alert");

      const dedupKey = `logger:${module}:${message.slice(0, 100)}`;
      const env = process.env.NODE_ENV === "production" ? "prod" : "dev";

      // Build subject. When the caller's msg is a generic title AND we
      // extracted a real detail message, append a 60-char detail
      // preview to the subject so the inbox glance reveals the actual
      // error. Kept short to leave room in mail-client subject truncation.
      // We only use the preview when the message looks generic — defined
      // as "ends with 'error'" (Prisma error / sendEmail error /
      // database error etc.) — otherwise the message itself is already
      // diagnostic.
      const looksGeneric = /\berror$/i.test(message.trim());
      const subjectBase = `[ea-sys][${env}] ${module}: ${message.slice(0, 80)}`;
      const subject =
        looksGeneric && detail
          ? `${subjectBase} — ${detail.replace(/\s+/g, " ").trim().slice(0, 60)}`
          : subjectBase;

      // Format the context as aligned key/value pairs. Truncate any
      // value over 500 chars so the email stays scannable (full detail
      // is still in /logs + Sentry).
      const contextLines = Object.entries(context)
        .map(([k, v]) => {
          let s: string;
          try {
            s = typeof v === "string" ? v : JSON.stringify(v);
          } catch {
            s = String(v);
          }
          if (s.length > 500) s = `${s.slice(0, 500)}…`;
          return `${k.padEnd(14)} ${s}`;
        })
        .slice(0, 20); // cap context fields

      const lines = [
        "An EA-SYS application error fired.",
        "",
        `Environment:   ${env}`,
        `Module:        ${module}`,
        `Message:       ${message}`,
        ...(detail ? [`Detail:        ${detail}`] : []),
        `Error signature: ${errSignature ?? "(none)"}`,
        ...(contextLines.length > 0 ? ["", "Context:", ...contextLines] : []),
        "",
        `Further occurrences of (${module} + same message prefix) within the next hour will NOT trigger another alert — open /logs in the dashboard or Sentry for the full picture.`,
        "",
        `--`,
        `ea-sys automated alert`,
      ].join("\n");

      await notifyAdminAlert({ subject, body: lines, dedupKey, detail });
    } catch {
      // Last-resort: any failure in this hook must NOT propagate, or
      // we'd kill the original log call.
    }
  })();
}

/**
 * Wraps a Pino child logger so that every .error() call also fires an
 * admin email alert via SES. Same shape as withSentryForwarding — both
 * are chained at createLogger so each .error() now triggers TWO push
 * paths (Sentry + admin email) in addition to the local log sinks
 * (stdout + file + SystemLog DB row).
 *
 * Skip patterns (ADMIN_ALERT_SKIP_PATTERNS above) prevent double-fire
 * with the email-failure path which has its own richer alert.
 */
function withAdminAlertForwarding(child: pino.Logger, module: string): pino.Logger {
  const originalError = child.error.bind(child);
  child.error = ((...args: unknown[]) => {
    forwardToAdminAlert(module, args);
    return (originalError as (...a: unknown[]) => void)(...args);
  }) as typeof child.error;
  return child;
}

export const createLogger = (module: string) =>
  withAdminAlertForwarding(withSentryForwarding(logger.child({ module }), module), module);

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
