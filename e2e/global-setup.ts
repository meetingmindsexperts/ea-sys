import { execSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { assertDisposableTestDb, E2E_DB_NAME } from "./test-db-guard";

/**
 * Rebuild the e2e database from the migration chain, then seed it.
 *
 * It used to `prisma db push` the schema onto whatever the test database held.
 * That stopped working once the schema gained unique constraints db push will
 * only add with --accept-data-loss, so the suite could not start at all (found
 * Nov 9, 2026), and it tested a database built differently from production's.
 * Now every run starts from an empty database and applies the same migrations
 * production does (`migrate deploy`, the one sanctioned migrate command), so a
 * run is deterministic and never depends on what a previous run left behind.
 */
export default async function globalSetup() {
  // Playwright runs outside Next.js, so .env.local isn't auto-loaded.
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const dbUrl = assertDisposableTestDb(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);

  const adminUrl = dbUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    console.log(`[playwright:setup] recreating ${E2E_DB_NAME}`);
    // FORCE ends the connections already open to it: the test server this run
    // started a moment earlier (Playwright starts the webServer BEFORE global
    // setup), which reconnects on its next query.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${E2E_DB_NAME}"`);
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl };

  console.log("[playwright:setup] applying the migration chain");
  execSync("npx prisma migrate deploy", { env, stdio: "inherit" });

  console.log("[playwright:setup] seeding fixture data");
  execSync("npx tsx prisma/seed-e2e.ts", { env, stdio: "inherit" });
}
