export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Validate env vars before anything else -- fail fast with clear errors
    const { validateEnv } = await import("./lib/env");
    validateEnv();

    await import("../sentry.server.config");

    // RLS tripwire (owner decision July 23, 2026: refuse to boot). When a
    // deployment claims tenant isolation (RLS_SET_LOCAL=1) but the DB
    // connection bypasses RLS (owner role — e.g. Supabase's default string —
    // or policies never applied), throwing here stops the server from ever
    // serving a request with silently-disabled isolation. Flag off (master):
    // returns immediately, no DB call.
    if (process.env.RLS_SET_LOCAL === "1") {
      const [{ assertRlsEnforced }, { db }] = await Promise.all([
        import("./lib/tenant/rls-assert"),
        import("./lib/db"),
      ]);
      await assertRlsEnforced(db);
    }
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
