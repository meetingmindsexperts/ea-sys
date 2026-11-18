import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyPolicyFiles, sharedPolicyDir, splitSql } from "../../prisma/rls/apply";
import { RLS_DB_NAME, RLS_OWNER_URL, RLS_SERVER_URL } from "./rls-env";

/**
 * The e2e database with ROW SECURITY ON: the first half of `npm run e2e:rls`.
 *
 * Built the way e2e/global-setup.ts builds it (an empty database, the migration
 * chain, the e2e seed), then given what a deployment with row security has and
 * master does not: the non-owner role the app connects as, and every policy in
 * prisma/rls. The suite then runs the whole product as that role.
 *
 * WHERE. On the tenancy harness's Postgres (localhost:55432), not on the
 * everyday test database: the non-owner role lives there. The address is a
 * constant in rls-env.ts and is never read from the environment, so this
 * cannot be aimed at the local production copy or at production by a stray
 * variable. That server holds only disposable databases.
 *
 * WHY A SCRIPT AND NOT PLAYWRIGHT'S GLOBAL SETUP. Playwright starts the test
 * server BEFORE global setup, and waits for it to answer. The everyday suite
 * gets away with that because its database is left over from the last run. A
 * machine that has never run this has no database at all, and a server with
 * no database never answers: the first run of this command waited ten minutes
 * and gave up (Nov 18, 2026). So the database is built first, then Playwright
 * is started.
 */
async function main() {
  const admin = new PrismaClient({ datasourceUrl: `${RLS_SERVER_URL}/postgres` });
  try {
    await admin.$queryRawUnsafe("SELECT 1");
  } catch {
    throw new Error(
      "The tenancy Postgres is not answering on localhost:55432. Start it first:\n" +
        "  docker compose --profile tenancy up -d",
    );
  }
  try {
    console.log(`[e2e:rls] recreating ${RLS_DB_NAME} on the tenancy Postgres`);
    // FORCE ends any connection a previous run's server left behind.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${RLS_DB_NAME}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${RLS_DB_NAME}"`);
  } finally {
    await admin.$disconnect();
  }

  const env = { ...process.env, DATABASE_URL: RLS_OWNER_URL, DIRECT_URL: RLS_OWNER_URL };
  console.log("[e2e:rls] applying the migration chain");
  execSync("npx prisma migrate deploy", { env, stdio: "inherit" });
  console.log("[e2e:rls] seeding fixture data");
  execSync("npx tsx prisma/seed-e2e.ts", { env, stdio: "inherit" });

  const owner = new PrismaClient({ datasourceUrl: RLS_OWNER_URL });
  try {
    const roles = path.resolve(process.cwd(), "tests/tenancy/policies/00-roles.sql");
    for (const statement of splitSql(readFileSync(roles, "utf8"))) await owner.$executeRawUnsafe(statement);

    const filled = await stampOrganisation(owner);
    const files = await applyPolicyFiles(owner, [sharedPolicyDir()]);
    const [{ n }] = await owner.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`,
    );
    console.log(`[e2e:rls] organisation stamped on ${filled} seeded rows; ${files.length} policy files, ${n} policies`);
    if (n === 0) throw new Error("No policy was applied: the run would prove nothing.");
  } finally {
    await owner.$disconnect();
  }
}

/**
 * The e2e seed is written for master and leaves the denormalised organisation
 * column empty on SOME of its rows (it stamps the attendee, the registration
 * and the serial counter); a policy hides a row with none, and five specs
 * failed for that reason alone (ROADMAP, "Row security rehearsal", item 2).
 * Filled here the way the migrations' backfills filled production: from the
 * row's event, then from the parent a table without an event names. When the
 * seed stamps the column itself this function finds nothing to do.
 */
async function stampOrganisation(owner: PrismaClient): Promise<number> {
  const tables = await owner.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.columns e
         ON e.table_name = c.table_name AND e.table_schema = c.table_schema AND e.column_name = 'eventId'
      WHERE c.table_schema = 'public' AND c.column_name = 'organizationId' AND c.table_name <> 'Event'`,
  );
  let filled = 0;
  for (const { table_name } of tables) {
    filled += await owner.$executeRawUnsafe(
      `UPDATE "${table_name}" t SET "organizationId" = e."organizationId"
         FROM "Event" e WHERE t."eventId" = e."id" AND t."organizationId" IS NULL`,
    );
  }
  const byParent = [
    `UPDATE "PricingTier" t SET "organizationId" = p."organizationId" FROM "TicketType" p WHERE t."ticketTypeId" = p."id" AND t."organizationId" IS NULL`,
    `UPDATE "Attendee" t SET "organizationId" = p."organizationId" FROM "Registration" p WHERE p."attendeeId" = t."id" AND t."organizationId" IS NULL`,
    `UPDATE "Payment" t SET "organizationId" = p."organizationId" FROM "Registration" p WHERE t."registrationId" = p."id" AND t."organizationId" IS NULL`,
    `UPDATE "SessionSpeaker" t SET "organizationId" = p."organizationId" FROM "EventSession" p WHERE t."sessionId" = p."id" AND t."organizationId" IS NULL`,
    `UPDATE "SessionTopic" t SET "organizationId" = p."organizationId" FROM "EventSession" p WHERE t."sessionId" = p."id" AND t."organizationId" IS NULL`,
  ];
  for (const sql of byParent) filled += await owner.$executeRawUnsafe(sql);
  return filled;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
