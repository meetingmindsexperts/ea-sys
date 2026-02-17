import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

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

// Development: pretty-print to console via pino-pretty (uses worker thread, fine in dev)
// Production:  plain pino — writes JSON directly to stdout, no worker threads,
//              no pino-abstract-transport dependency, works correctly on Vercel.
export const logger = isDevelopment
  ? pino({
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
    })
  : pino(loggerConfig);

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
