import { defineConfig, devices } from "@playwright/test";

/**
 * The online venue's own walking checks (vendor/ehc-venue/tests/walk.spec.ts): every generated and drawn
 * layout fixture, loaded into the built page and walked by tests/layout_verify.js. No app server and no
 * database: the spec serves the built page and the fixtures itself. Run after `npm run venue:build`:
 *
 *   npm run venue:walk
 *
 * CI runs it in the `venue` job of deploy.yml (venue hardening step 1, Oct 26, 2026).
 */
export default defineConfig({
  testDir: "./vendor/ehc-venue/tests",
  testMatch: "walk.spec.ts",
  // Each layout is its own WebGL page; a few at once keeps the run short without starving the GPU emulation.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 240_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        // WebGL 2 without a GPU, as the vendor's Python tests ran it.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
      },
    },
  ],
});
