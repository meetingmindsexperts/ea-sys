import pino, { multistream } from "pino";
import { join } from "path";
import { accessSync, constants, mkdirSync } from "fs";

const isDevelopment = process.env.NODE_ENV === "development";
const isVercel = !!process.env.VERCEL;

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

// Development: pretty-print to console via pino-pretty (uses worker thread, fine in dev)
// Production on Vercel: plain pino → stdout only (no writable filesystem in serverless)
// Production on EC2/Docker: pino.multistream → stdout + logs/app.log + logs/error.log
function initLogger(): pino.Logger {
  if (isDevelopment) {
    return pino({
      ...loggerConfig,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname,env,app",
          singleLine: false,
        },
      },
    });
  }

  if (isVercel) {
    return pino(loggerConfig);
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
