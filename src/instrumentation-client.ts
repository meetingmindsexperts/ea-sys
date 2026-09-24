import * as Sentry from "@sentry/nextjs";

/**
 * Browser-side Sentry.
 *
 * NEXT_PUBLIC_SENTRY_DSN is inlined at BUILD time, so it has to be present in
 * the environment `next build` runs in (the Docker build stage, fed by CI),
 * not only on the server at runtime. Until 24 Sep 2026 it never was: the
 * production bundle carried no DSN, `enabled` was always false, and every
 * visitor downloaded the full SDK with session replay for nothing.
 */
const enabled = process.env.NODE_ENV === "production" && !!process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Replay is attached later (below), not listed here: naming it in the
  // integrations array pulls its code into the bundle every page downloads.
  integrations: [],

  // Session Replay. Read when the integration is added, so these still apply.
  // Replays mask all text and inputs and block media by default, which is what
  // registration forms full of personal details need; do not loosen them.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  enabled,
  enableLogs: true,
});

/**
 * Session replay, on demand: loaded once the page is idle, from its own chunk.
 *
 * Imported from `@sentry/replay` by name, NOT from `@sentry/nextjs`: the page
 * already imports `@sentry/nextjs` statically, and a dynamic import of a module
 * that is also imported statically stays in the main bundle, so the split
 * would not happen. `@sentry/replay` is a dependency of the SDK and always at
 * the SDK's own version, so it is not pinned separately in package.json (a
 * second pin could drift and load two copies of the Sentry core).
 *
 * The trade-off: an error in the first moments of a page, before the browser
 * is idle, is reported without a replay. Errors themselves are unaffected.
 */
if (enabled && typeof window !== "undefined") {
  const attachReplay = () => {
    import("@sentry/replay")
      .then(({ replayIntegration }) => Sentry.addIntegration(replayIntegration()))
      .catch((err) => {
        // A missing chunk (a deploy mid-session) or a blocked request must not
        // break the page; say so rather than fail silently.
        console.warn("sentry:replay-load-failed", err);
      });
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(attachReplay, { timeout: 5000 });
  else setTimeout(attachReplay, 3000);
}

// Required by Next.js 16+ for navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
