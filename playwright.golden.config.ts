import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

/**
 * The Event Agent golden task set (readiness review E2): real model calls,
 * real requests through /api/agent/execute on a dedicated app server, the
 * seeded test database, grading in code. NOT a regression test: it costs
 * money and depends on a live model, so it is never collected by
 * `npm run test:e2e` (that config ignores this folder) or by the pre-push
 * gate. Run it on demand:
 *
 *   npm run agent:golden                  # one pass, ~30 tasks, ~4 minutes
 *   npm run agent:golden -- --repeat-each 3   # pass rate over three runs
 *   AGENT_MODEL=claude-sonnet-5 npm run agent:golden   # compare a model (E5)
 *
 * Output: test-results/agent-golden/{tasks.jsonl,summary.json,summary.md}.
 * Differences from playwright.config.ts: the app is the PRODUCTION
 * STANDALONE on its own port (3120), started by e2e/agent-golden/_server.mjs
 * (Next 16 allows one `next dev` per checkout, and the everyday one holds
 * it); a 4-minute per-task timeout (a task is one or two model round trips,
 * usually under 20 seconds); retries off (a flake is a finding, not noise);
 * and its own seed.
 */

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

const PORT = process.env.AGENT_GOLDEN_PORT ?? "3120";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const testDbUrl = process.env.DATABASE_URL_TEST;

export default defineConfig({
  testDir: "./e2e/agent-golden",
  testIgnore: ["**/_*.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/agent-golden/playwright.json" }],
  ],
  globalSetup: "./e2e/agent-golden/_global-setup.ts",
  globalTeardown: "./e2e/agent-golden/_global-teardown.ts",
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // The production standalone, not `next dev`: Next 16 allows one dev
        // server per checkout and the everyday one holds it. The launcher
        // rebuilds when src/ is newer than the build (a few minutes), so the
        // start timeout covers a build.
        command: "node e2e/agent-golden/_server.mjs",
        url: baseURL,
        // A reused server keeps its in-memory rate-limit counters; the
        // account rotation in _harness.ts absorbs that for a few repeats.
        reuseExistingServer: !process.env.CI,
        timeout: 600_000,
        env: {
          PORT,
          NEXTAUTH_URL: baseURL,
          NEXT_PUBLIC_APP_URL: baseURL,
          ...(testDbUrl ? { DATABASE_URL_TEST: testDbUrl } : {}),
        },
      },
});
