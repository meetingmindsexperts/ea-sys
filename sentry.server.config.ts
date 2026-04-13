import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Capture 10% of transactions for performance monitoring
  tracesSampleRate: 0.1,

  // Only enable if DSN is configured
  enabled: !!(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),

  enableLogs: true,

  ignoreErrors: [/router state header/i],
});
