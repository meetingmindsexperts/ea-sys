/**
 * Per-worker env bridge (mirrors tests/tenancy/setup-env.ts). vitest's
 * globalSetup runs in the runner process — its env doesn't reach test workers —
 * so this setupFile (which runs in each worker BEFORE the test file's imports)
 * points `@/lib/db` at the CRM harness DB. Every test then shares the same
 * `db` singleton for both seeding and asserting, against real Postgres.
 */
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const url = process.env.CRM_TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "CRM_TEST_DATABASE_URL must be set (see .env.example / docker compose --profile crm-test). " +
      "Default: postgres://postgres:postgres@localhost:55432/crm_test.",
  );
}

process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
// The inbox feature is dormant unless these are set — keep them unset so tests
// exercise the DB-facing logic, not the S3/SES side (that's the mocked suite).
delete process.env.CRM_REPLY_DOMAIN;
delete process.env.CRM_INBOUND_S3_BUCKET;
