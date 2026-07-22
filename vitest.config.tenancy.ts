import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Tenant-isolation harness (multi-tenancy Phase 0) — a SEPARATE vitest
 * project from the mocked unit suite: these tests run against a REAL
 * Postgres (+ pgbouncer in transaction mode) with the pilot RLS policy
 * applied, seeded with two tenants. Run via `npm run test:tenancy` with
 * TENANCY_DATABASE_URL / TENANCY_DIRECT_URL set (locally:
 * `docker compose --profile tenancy up -d`; in CI: service containers).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/tenancy/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One file at a time — the suites share the seeded fixture state and the
    // process-wide env flags (RLS_SET_LOCAL), so parallel files would race.
    fileParallelism: false,
    globalSetup: "tests/tenancy/global-setup.ts",
    setupFiles: ["tests/tenancy/setup-env.ts"],
  },
});
