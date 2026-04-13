export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Validate env vars before anything else -- fail fast with clear errors
    const { validateEnv } = await import("./lib/env");
    validateEnv();

    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) => {
  const [err] = args;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Malformed Next-Router-State-Tree headers come from stale clients, bots, and
  // proxies stripping/mutating headers. Nothing we can fix server-side, and
  // Sentry would otherwise alert on every hit.
  if (/router state header/i.test(message)) {
    return;
  }

  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
