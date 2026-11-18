import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { RLS_APP_URL, RLS_OWNER_URL, RLS_PORT, RLS_SERVER_LOG } from "./e2e/rls/rls-env";

/**
 * `npm run e2e:rls`: the whole product with ROW SECURITY ON.
 *
 * The same browser suite as playwright.config.ts, against the same standalone
 * build, with three differences: the database is built with every policy in
 * prisma/rls (e2e/rls/setup.ts, run first by the npm script), the app connects as the non-owner role
 * those policies apply to, and two more specs run at the end: every page asked
 * as each role (route-smoke.spec.ts, in the suite, asks the routes), and a read
 * of the server's log, where a refused write or a read outside a tenant lane
 * shows up when no request failed.
 *
 * This is the check for "would this break the day row security is switched
 * on". It needs the tenancy Postgres (docker compose --profile tenancy up -d)
 * and is not part of `npm run gate`. One organisation only: the two-tenant
 * check is the sandbox (docs/SANDBOX.md).
 */
dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

// The specs that look rows up for themselves (route-smoke's ids, the import
// spec's reads) take their database from DATABASE_URL_TEST. Left to .env.local
// that is the EVERYDAY test database, on another server: the ids they found
// did not exist on the one the app was running on, so about twenty detail
// routes answered 404 whatever their lane did (review of fc7a7ebb). They read
// as the owner; the server below is given the restricted role.
process.env.DATABASE_URL_TEST = RLS_OWNER_URL;

const baseURL = `http://localhost:${RLS_PORT}`;
const serverLog = path.resolve(__dirname, RLS_SERVER_LOG);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  use: { baseURL, trace: "off", screenshot: "only-on-failure" },
  projects: [
    {
      name: "suite",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        "**/fixtures/**", "**/agent-golden/**", "**/screenshots/**", "**/tenancy-shots/**", "**/rls/**",
      ],
      // Runs when the suite has finished, whether or not a spec failed: the
      // server log matters most on the day something did. Two things defeat
      // that, so do not pass them: --max-failures (or -x) stops before the
      // teardown, and more than one worker reads the log while pages are
      // still being asked.
      teardown: "after the suite",
    },
    { name: "after the suite", use: { ...devices["Desktop Chrome"] }, testMatch: ["**/rls/pages.spec.ts", "**/rls/server-log.spec.ts"] },
  ],
  webServer: {
    // The server's output goes to a file, which server-log.spec.ts reads.
    command: `mkdir -p "${path.dirname(serverLog)}" && node e2e/agent-golden/_server.mjs > "${serverLog}" 2>&1`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      PORT: RLS_PORT,
      NEXTAUTH_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      // The non-owner role for the app, the owner for its privileged lane.
      DATABASE_URL_TEST: RLS_APP_URL,
      DATABASE_URL_OPERATOR: RLS_OWNER_URL,
      RLS_SET_LOCAL: "1",
      // The detector: an Event query outside a lane is logged by name.
      RLS_SHADOW: "1",
      DEFAULT_ORG_ID: "e2e-org",
      LOG_LEVEL: "info",
      // As playwright.config.ts: never AWS, never Sentry, no outside IP lookups, a cron secret that is set.
      AWS_ACCESS_KEY_ID: "not-a-real-key",
      AWS_SECRET_ACCESS_KEY: "fake",
      AWS_SESSION_TOKEN: "",
      AWS_PROFILE: "",
      AWS_ENDPOINT_URL: "http://127.0.0.1:9",
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      LOGIN_GEO_ENABLED: "false",
      CRON_SECRET: "e2e-cron-secret-never-sent",
    },
  },
});
