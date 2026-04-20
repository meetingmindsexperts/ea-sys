import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// Load .env.local (and .env) so DATABASE_URL_TEST is picked up here AND
// forwarded to the webServer + globalSetup subprocesses via process.env.
dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = process.env.PORT ?? "3000";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const testDbUrl = process.env.DATABASE_URL_TEST;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/fixtures/**"],
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
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // Point the dev server at the test DB so the app Playwright drives
        // reads the same rows the seed script just wrote.
        env: testDbUrl
          ? { DATABASE_URL: testDbUrl, DIRECT_URL: testDbUrl }
          : undefined,
      },
});
