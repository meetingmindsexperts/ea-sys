import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Real-Postgres integration harness: a SEPARATE vitest project from the mocked unit
 * suite (`vitest run`). These tests run against a REAL Postgres so that the
 * things mocks cannot verify actually apply: `@@unique` races (the inbox
 * s3Key dedupe), `$transaction` atomicity, conditional-claim `updateMany`,
 * org-scoped `where`, and the junction `organizationId`.
 *
 * Run via `npm run test:integration-db` with INTEGRATION_TEST_DATABASE_URL set.
 * Locally: `docker compose --profile crm-test up -d`, then the URL is
 * postgres://postgres:postgres@localhost:55432/crm_test (see .env.example).
 * In CI: a postgres service container. The physical database and the compose
 * profile keep their historical `crm_test` / `crm-test` names, so no local
 * re-provisioning is needed; only the harness naming changed.
 *
 * Mirrors the tenancy harness (vitest.config.tenancy.ts) — same globalSetup +
 * setupFile split, because vitest's globalSetup env doesn't reach test workers.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/integration-db/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The suites share one seeded DB and truncate between tests — parallel
    // files would race on the shared rows.
    fileParallelism: false,
    globalSetup: "tests/integration-db/global-setup.ts",
    setupFiles: ["tests/integration-db/setup-env.ts"],
  },
});
