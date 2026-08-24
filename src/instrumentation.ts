export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Validate env vars before anything else -- fail fast with clear errors
    const { validateEnv } = await import("./lib/env");
    validateEnv();

    await import("../sentry.server.config");

    // Start the event-loop delay histogram at boot (side-effect import) so
    // /api/health's `eventLoop` stats cover the whole process life, not just
    // from the first health hit. Node runtime only — perf_hooks isn't
    // available on the edge runtime.
    await import("./lib/event-loop-monitor");

    // RLS tripwire (owner decision July 23, 2026: refuse to boot). When a
    // deployment claims tenant isolation (RLS_SET_LOCAL=1) but the DB
    // connection bypasses RLS (owner role — e.g. Supabase's default string —
    // or policies never applied), throwing here stops the server from ever
    // serving a request with silently-disabled isolation. Flag off (master):
    // returns immediately, no DB call.
    // Stripe env-fallback sanity (Aug 24, 2026). The shared STRIPE_SECRET_KEY
    // is usable by exactly ONE org, named by STRIPE_ENV_FALLBACK_ORG_ID.
    // Two misconfigurations are worth shouting about at boot rather than
    // discovering when a registrant clicks Pay:
    //
    //  - key present, no org named: nobody can use it. On master that means
    //    MM Group's checkouts will refuse (the deploy-order trap).
    //  - org named, no key: the allow-list points at a key that isn't there.
    //
    // Deliberately a log, not a throw. The RLS tripwire above refuses to boot
    // because serving with isolation silently off is worse than being down;
    // here the failure mode is already fail-closed at the point of use, so
    // taking the whole app down would turn a payments problem into an outage.
    {
      const envKey = !!process.env.STRIPE_SECRET_KEY;
      const fallbackOrg = process.env.STRIPE_ENV_FALLBACK_ORG_ID?.trim();
      const { apiLogger } = await import("./lib/logger");
      if (envKey && !fallbackOrg) {
        apiLogger.error(
          "stripe:env-key-present-but-no-org-allowed — STRIPE_SECRET_KEY is set but STRIPE_ENV_FALLBACK_ORG_ID is not, so NO organization can use it. On master set it to MM Group's org id; on the platform unset STRIPE_SECRET_KEY.",
        );
      } else if (!envKey && fallbackOrg) {
        apiLogger.error(
          { organizationId: fallbackOrg },
          "stripe:fallback-org-set-but-no-env-key — STRIPE_ENV_FALLBACK_ORG_ID names an org but STRIPE_SECRET_KEY is not set.",
        );
      }
    }

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
