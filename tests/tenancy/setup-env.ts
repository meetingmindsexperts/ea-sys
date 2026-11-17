/**
 * Per-worker env bridge for the tenancy harness. vitest's globalSetup runs in
 * the runner process — its env changes don't reach test workers — so this
 * setupFile (which runs in each worker BEFORE the test file's imports) points
 * `@/lib/db` at the harness's POOLED app_user connection. Owners bypass RLS;
 * the whole point is that the app path runs as the non-owner role through
 * pgbouncer transaction pooling.
 */
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const pooled = process.env.TENANCY_DATABASE_URL;
if (!pooled) {
  throw new Error("TENANCY_DATABASE_URL must be set (see .env.example / docker compose --profile tenancy)");
}

process.env.DATABASE_URL = pooled;
process.env.DIRECT_URL = pooled;
// The privileged lane, as the platform runs it: `dbOperator` connects as the
// table OWNER, which row security does not bind (PLATFORM_PROVISIONING §
// DATABASE_URL_OPERATOR). Since Event carries a policy (Nov 17, 2026) the one
// read made before a lane exists goes through it, so without this a reviewer,
// submitter or registrant would find no event anywhere in the harness.
const owner = process.env.TENANCY_DIRECT_URL;
if (!owner) throw new Error("TENANCY_DIRECT_URL must be set (the owner connection; see .env.example)");
process.env.DATABASE_URL_OPERATOR = owner;

// Deterministic resolver behavior regardless of the developer's shell env.
delete process.env.DEFAULT_ORG_ID;
delete process.env.TENANCY_ENFORCE_HOST;
delete process.env.RLS_SET_LOCAL; // suites opt in per-test
