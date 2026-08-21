/**
 * Warm the sandbox dev server before the isolation suite runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * This config deliberately declares no `webServer`: the sandbox carries a
 * specific environment (app-role connection string, both tenancy flags) that
 * the test rig has no business reproducing, so you start it yourself and leave
 * it running. The consequence is that the suite's first run after
 * `npm run dev:sandbox` meets a server that has compiled nothing, and Next
 * compiles per route on first request.
 *
 * Observed Aug 21 2026: the first test absorbed 1.5 minutes of compilation and
 * passed; a later one issued an API request into a route still being built and
 * failed on a bare status assertion. The code was fine — it had passed 7/7
 * twice minutes earlier and passed again immediately on a warm server.
 *
 * `retries` would have hidden that, and would go on hiding a real flake later.
 * Warming the routes removes the cause instead, and costs nothing once the
 * server is warm. **A suite that goes red for a reason unrelated to the code
 * trains people to ignore it**, which is worse than not having it.
 *
 * Deliberately ignores every response: a 401, 403 or 404 compiles the route
 * just as well as a 200, and this must never be able to fail the run — its
 * whole job is to make failures mean something.
 */
const PORT = process.env.SANDBOX_PORT ?? "3114";
const HOSTS = [`acme.localhost:${PORT}`, `globex.localhost:${PORT}`, `platform.localhost:${PORT}`];

/** Every path the suite touches, unauthenticated — enough to compile each one. */
const PATHS = [
  "/login",
  "/api/events",
  "/api/contacts?page=1&limit=50",
  "/api/registrant/registrations",
  "/api/logs?since=10m&source=database",
  "/api/organizations",
  "/api/admin/docs/tree",
  "/api/health",
];

export default async function warmup(): Promise<void> {
  const started = Date.now();
  await Promise.all(
    HOSTS.flatMap((host) =>
      PATHS.map((path) =>
        fetch(`http://${host}${path}`, { redirect: "manual" }).catch(() => undefined),
      ),
    ),
  );
  console.log(`[tenancy:warmup] ${HOSTS.length * PATHS.length} routes in ${Date.now() - started}ms`);
}
