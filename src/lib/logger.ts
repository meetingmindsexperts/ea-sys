import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isDevelopment = process.env.NODE_ENV === "development";

// Create the base logger configuration
const loggerConfig: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),

  // Custom serializers to format specific data
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
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },

  // Redact sensitive fields
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

  // Base context for all logs
  base: {
    env: process.env.NODE_ENV,
    app: "ea-sys",
  },

  // Timestamp configuration
  timestamp: pino.stdTimeFunctions.isoTime,
};

// In development, use pino-pretty for readable output
// In production, use JSON format for log aggregation
const transport = isDevelopment
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname,env,app",
        singleLine: false,
      },
    }
  : undefined;

// Create the logger instance
export const logger = pino({
  ...loggerConfig,
  ...(transport && { transport }),
});

// Create child loggers for different modules
export const createLogger = (module: string) => {
  return logger.child({ module });
};

// Pre-configured loggers for common modules
export const dbLogger = createLogger("database");
export const authLogger = createLogger("auth");
export const apiLogger = createLogger("api");
export const eventLogger = createLogger("events");

// Utility function for logging API requests
export const logApiRequest = (
  method: string,
  path: string,
  userId?: string,
  organizationId?: string
) => {
  apiLogger.info({
    msg: `${method} ${path}`,
    method,
    path,
    userId,
    organizationId,
  });
};

// Utility function for logging API errors
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

// Utility function for logging database operations
export const logDbOperation = (
  operation: string,
  model: string,
  duration?: number
) => {
  dbLogger.debug({
    msg: `DB ${operation} on ${model}`,
    operation,
    model,
    duration: duration ? `${duration}ms` : undefined,
  });
};

// Utility function for logging authentication events
export const logAuthEvent = (
  event: "login" | "logout" | "register" | "failed_login",
  email?: string,
  userId?: string
) => {
  const logFn = event === "failed_login" ? authLogger.warn : authLogger.info;
  logFn({
    msg: `Auth event: ${event}`,
    event,
    email,
    userId,
  });
};

// Export default logger for general use
export default logger;
