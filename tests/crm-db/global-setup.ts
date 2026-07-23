/**
 * CRM integration harness provisioning (mirrors tests/tenancy/global-setup.ts):
 * ensure the `crm_test` database exists on the SHARED test-Postgres container
 * (the same server the tenancy harness uses — different database, owner-direct,
 * no RLS/pgbouncer), then push the Prisma schema to it once. Per-test isolation
 * (truncate + seed) lives in the helper.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

export default async function globalSetup() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const url = process.env.CRM_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "CRM_TEST_DATABASE_URL must be set. Locally: `docker compose --profile crm-test up -d`, then " +
        "CRM_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/crm_test (see .env.example).",
    );
  }

  // Create the crm_test database if it doesn't exist yet — connect to the
  // server's default `postgres` db (same host/port/creds, swap the db name).
  const dbName = new URL(url).pathname.replace(/^\//, "") || "crm_test";
  const adminUrl = url.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`[crm-db:setup] created database ${dbName}`);
  } catch (err) {
    // 42P04 = database already exists — expected on re-runs.
    if (!(err instanceof Error && /already exists|42P04/.test(err.message))) throw err;
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  console.log("[crm-db:setup] pushing schema to the crm_test DB");
  execSync("npx prisma db push --skip-generate --accept-data-loss", { env, stdio: "inherit" });
}
