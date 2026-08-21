import { defineConfig, devices } from "@playwright/test";

/**
 * Screenshot capture for the multi-tenancy demonstration.
 *
 * Separate from playwright.docs.config.ts because it targets a different rig:
 * the two-tenant sandbox (npm run sandbox:setup) served by `npm run dev:sandbox`
 * on port 3114, where the app runs as the non-owner `app_user` with
 * RLS_SET_LOCAL=1 and TENANCY_ENFORCE_HOST=1.
 *
 * Deliberately declares NO webServer. The sandbox server carries a specific
 * environment (the app-role connection string and both tenancy flags) that this
 * config has no business reproducing, and starting a second one would only
 * collide with Next's one-dev-server-per-directory lock. Start it yourself:
 *
 *   docker compose --profile tenancy up -d
 *   npm run sandbox:setup      # once
 *   npm run dev:sandbox        # leave running
 *   npm run tenancy:screenshots
 *
 * No baseURL either: every navigation here is an absolute URL, because the
 * HOST is the variable under demonstration.
 */
export default defineConfig({
  testDir: "./e2e/tenancy-shots",
  // Compile the routes the suite uses before the first assertion — see the
  // header of _warmup.ts. Not `retries`: that would hide this AND hide a real
  // flake later.
  globalSetup: "./e2e/tenancy-shots/_warmup.ts",
  testIgnore: ["**/_*.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
