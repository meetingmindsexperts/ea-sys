import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { assertDisposableTestDb } from "./e2e/test-db-guard";

// Load .env.local (and .env) so DATABASE_URL_TEST is picked up here AND
// forwarded to the webServer + globalSetup subprocesses via process.env.
dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

// 3199, never 3000 or 3113 (W1-2, Nov 9, 2026). 3000 matched nothing: `npm run
// dev` binds 3113, so a bare run waited out its timeout. And 3113 is the
// everyday dev server, which reads the local production copy: reusing it ran
// the specs, which create and delete rows, against that copy while the seed
// had gone to ea_sys_test.
const PORT = process.env.E2E_PORT ?? "3199";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const testDbUrl = process.env.DATABASE_URL_TEST;

// Before anything starts: Playwright launches the webServer BEFORE global setup,
// so the guard global setup runs would come too late for the server.
assertDisposableTestDb(testDbUrl, process.env.DATABASE_URL);

// An external server is opt-in. PLAYWRIGHT_BASE_URL alone used to be enough,
// and pointing it at :3113 runs the specs (which create and delete rows)
// against the everyday dev server and the local production copy behind it.
if (process.env.PLAYWRIGHT_BASE_URL && process.env.E2E_EXTERNAL_SERVER !== "1") {
  throw new Error(
    "PLAYWRIGHT_BASE_URL is set: that server's own database gets the specs' writes, not ea_sys_test. " +
      "Set E2E_EXTERNAL_SERVER=1 as well if that server really runs on ea_sys_test.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  // agent-golden makes real model calls (playwright.golden.config.ts). screenshots
  // and tenancy-shots have their own seed and server (playwright.docs.config.ts,
  // playwright.tenancy.config.ts on :3114); run here they only time out. rls is
  // the row security run (playwright.rls.config.ts, `npm run e2e:rls`).
  testIgnore: ["**/fixtures/**", "**/agent-golden/**", "**/screenshots/**", "**/tenancy-shots/**", "**/rls/**"],
  // Specs share a seeded DB; running in parallel would let workers race against
  // each other (e.g. the admin-smoke spec mutates the event list). One worker
  // keeps the suite deterministic without costing much at this size.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // The production standalone (the launcher rebuilds it when src/ is
        // newer), not `next dev`: Next 16 allows one dev server per checkout
        // and the everyday one holds it. Never reused, so a run always starts
        // with fresh in-memory rate limits and can never land on another
        // server: a busy port fails the run instead.
        command: "node e2e/agent-golden/_server.mjs",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 600_000,
        env: {
          PORT,
          NEXTAUTH_URL: baseURL,
          NEXT_PUBLIC_APP_URL: baseURL,
          // The test server must never reach AWS (Nov 17, 2026). A laptop with
          // ~/.aws/credentials gave it real SES, so a spec that registers
          // someone could send real email. Bogus keys and a dead endpoint:
          // every send fails fast and is logged, as it would with no network.
          AWS_ACCESS_KEY_ID: "not-a-real-key",
          AWS_SECRET_ACCESS_KEY: "fake",
          AWS_SESSION_TOKEN: "",
          AWS_PROFILE: "",
          AWS_ENDPOINT_URL: "http://127.0.0.1:9",
          // Nor report to Sentry: a crash the suite provokes on purpose is not a production error.
          SENTRY_DSN: "",
          NEXT_PUBLIC_SENTRY_DSN: "",
          // No outside IP lookups: the sign-in activity read resolves addresses with a third party unless told not to.
          LOGIN_GEO_ENABLED: "false",
          // Set, so the legacy cron shims refuse an unsigned caller with 401 as
          // they do in production. Unset, they answer 500 "Server misconfigured",
          // which the route smoke test would have to excuse.
          CRON_SECRET: "e2e-cron-secret-never-sent",
          ...(testDbUrl ? { DATABASE_URL_TEST: testDbUrl } : {}),
        },
      },
});
