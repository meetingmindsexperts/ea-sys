import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

/**
 * Separate Playwright config for **screenshot capture**, not regression
 * testing. Points at `./e2e/screenshots/` (the regular e2e config ignores
 * that directory).
 *
 * Differences from playwright.config.ts:
 *   - 1440×900 viewport with deviceScaleFactor=2 for retina-crisp PNGs
 *   - reduceMotion=reduce so animated UI freezes mid-render in screenshots
 *   - screenshots run serially (workers=1) so navigation between specs
 *     doesn't fight for the seeded DB
 *   - retries=0; if a screenshot fails we want the failure surfaced, not
 *     papered over by a flaky-retry success
 *
 * Usage:
 *   npm run docs:screenshots
 *
 * Output:
 *   docs/screenshots/{chapter}/{name}.png
 */

dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, ".env") });

// Dedicated port for screenshot runs so we never collide with a long-running
// `npm run dev` on 3000.
const PORT = process.env.DOCS_PORT ?? "3100";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const testDbUrl = process.env.DATABASE_URL_TEST;

export default defineConfig({
  testDir: "./e2e/screenshots",
  testIgnore: ["**/_*.ts"],
  fullyParallel: false,
  workers: 1,
  // First-compile in dev can be slow; screenshot specs hit ~10 routes
  // each so we give them headroom rather than retrying on cold-start.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Force light mode for consistent docs (manual is screenshot-heavy
    // and dark-mode renders look inconsistent across pages).
    colorScheme: "light",
    // Reduced motion is set via contextOptions (not a top-level use option
    // in this Playwright version) — see the project's contextOptions below.
    contextOptions: {
      reducedMotion: "reduce",
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Override device viewport so screenshots match the 1440×900 retina
        // baseline expected by the manual.
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        // Force dedicated port so we don't reuse a stale dev server on 3000.
        command: `next dev -p ${PORT}`,
        url: baseURL,
        // Reuse the prior screenshot-run server only — the dedicated port
        // means this is always the one we just started.
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          PORT,
          // Override NextAuth + public URL so absolute redirects land on
          // the dedicated screenshot port (otherwise the submitter portal
          // bounces to NEXTAUTH_URL=localhost:3000 mid-test).
          NEXTAUTH_URL: baseURL,
          NEXT_PUBLIC_APP_URL: baseURL,
          ...(testDbUrl ? { DATABASE_URL: testDbUrl, DIRECT_URL: testDbUrl } : {}),
        },
      },
});
