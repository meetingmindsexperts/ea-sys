/**
 * Safety guard for local-only DB scripts. Local `npm run dev` points at the
 * PROD Supabase DB, and if DATABASE_URL_TEST is unset a bare Prisma client
 * silently falls back to that prod DATABASE_URL — so a "local" seed would
 * write to production. This module:
 *   1. loads .env.local / .env (npm scripts don't auto-load them),
 *   2. resolves DATABASE_URL_TEST,
 *   3. refuses to run unless it's an obviously-LOCAL database,
 *   4. forces DATABASE_URL/DIRECT_URL to the test DB for the process.
 *
 * Import this FIRST (before any @/lib/db or PrismaClient import) in every
 * local seed/verify script.
 */
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const testUrl = process.env.DATABASE_URL_TEST;

if (!testUrl) {
  throw new Error(
    "[local-db-guard] DATABASE_URL_TEST is not set. Refusing to run — a local seed must never touch the prod DATABASE_URL. Add DATABASE_URL_TEST to .env.local.",
  );
}

const isLocal = /@localhost[:/]|@127\.0\.0\.1[:/]|\/ea_sys_test(\?|$)/.test(testUrl);
if (!isLocal) {
  throw new Error(
    `[local-db-guard] DATABASE_URL_TEST does not look like a local test DB (expected localhost / ea_sys_test). Refusing to run to avoid touching a non-local database. Got host/db: ${testUrl.replace(/:[^:@/]+@/, ":<pw>@")}`,
  );
}

// Force the whole process onto the test DB, whatever .env said.
process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testUrl;

export const LOCAL_TEST_DB_URL = testUrl;
