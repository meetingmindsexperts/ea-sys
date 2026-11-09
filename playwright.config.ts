import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

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

export default defineConfig({
  testDir: "./e2e",
  // agent-golden makes real model calls (playwright.golden.config.ts). screenshots
  // and tenancy-shots have their own seed and server (playwright.docs.config.ts,
  // playwright.tenancy.config.ts on :3114); run here they only time out.
  testIgnore: ["**/fixtures/**", "**/agent-golden/**", "**/screenshots/**", "**/tenancy-shots/**"],
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
          ...(testDbUrl ? { DATABASE_URL_TEST: testDbUrl } : {}),
        },
      },
});
