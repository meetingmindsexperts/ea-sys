import * as Sentry from "@sentry/nextjs";
Sentry.init({
  dsn: "https://8a121fec827a962fa60137deaa5de667@o4510939405746176.ingest.de.sentry.io/4510939407515728",
  integrations: [
    Sentry.replayIntegration(),
  ],
  // Session Replay
  replaysSessionSampleRate: 0.1, // This sets the sample rate at 10%. You may want to change it to 100% while in development and then sample at a lower rate in production.
  replaysOnErrorSampleRate: 1.0, // If you're not already sampling the entire session, change the sample rate to 100% when sampling sessions where errors occur.
});
