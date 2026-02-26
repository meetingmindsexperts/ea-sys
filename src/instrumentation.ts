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
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
};
