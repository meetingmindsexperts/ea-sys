/**
 * Provision the LOCAL multi-tenant RLS sandbox — see docs/SANDBOX.md.
 *
 * Creates a dedicated `sandbox` database INSIDE the existing tenancy Postgres
 * container (so `npm run test:tenancy` — which wipes the `tenancy` db — never
 * clobbers it), then:
 *   1. CREATE DATABASE sandbox (idempotent)
 *   2. prisma db push (full schema, OWNER connection)
 *   3. apply the role split (tests/tenancy/policies/00-roles.sql) + EVERY
 *      per-domain policy in prisma/rls/*.sql. Since Nov 17, 2026 that includes
 *      Event (prisma/rls/event.sql): until then its policy was a harness-only
 *      pilot, kept out of the sandbox because reads of Event ran outside a
 *      tenant lane and the dashboard would have come back empty.
 *   4. seed two tenants (scripts/seed-sandbox.ts)
 *
 * The app then connects as the non-owner `app_user` (RLS enforces) via
 * `npm run dev:sandbox`. LOCAL ONLY — never a prod database.
 *
 * Prereq: the tenancy container must be up —
 *   docker compose --profile tenancy up -d
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyPolicyFiles, splitSql, sharedPolicyDir } from "../prisma/rls/apply";

const CONTAINER = process.env.SANDBOX_PG_CONTAINER || "ea-sys-tenancy-db";
const OWNER_URL =
  process.env.SANDBOX_OWNER_URL || "postgresql://postgres:postgres@localhost:55432/sandbox";

async function main() {
  // 1. create the sandbox database (from inside the container; can't CREATE
  //    DATABASE while connected to the target, so connect to `tenancy`).
  console.log("[sandbox] ensuring the 'sandbox' database exists");
  try {
    execSync(`docker exec ${CONTAINER} psql -U postgres -d tenancy -c "CREATE DATABASE sandbox"`, {
      stdio: "pipe",
    });
    console.log("[sandbox]   created database 'sandbox'");
  } catch (e: unknown) {
    const stderr =
      e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr) : "";
    const msg = stderr || (e instanceof Error ? e.message : String(e));
    if (/already exists/i.test(msg)) {
      console.log("[sandbox]   database 'sandbox' already exists");
    } else {
      throw new Error(
        `Failed to create the sandbox DB. Is the tenancy container up?\n` +
          `  docker compose --profile tenancy up -d\n\n${msg}`,
      );
    }
  }

  // 2. schema
  console.log("[sandbox] syncing schema (prisma db push)");
  execSync("npx prisma db push --skip-generate", {
    env: { ...process.env, DATABASE_URL: OWNER_URL, DIRECT_URL: OWNER_URL },
    stdio: "inherit",
  });

  // 3. role split + domain policies (Event's among them since Nov 17, 2026)
  console.log("[sandbox] applying role split + domain RLS policies");
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  try {
    // The role split first, by explicit path: the one file in
    // tests/tenancy/policies. Every policy is in prisma/rls.
    const rolesFile = path.resolve(process.cwd(), "tests/tenancy/policies/00-roles.sql");
    for (const statement of splitSql(readFileSync(rolesFile, "utf8"))) {
      await owner.$executeRawUnsafe(statement);
    }
    console.log("[sandbox]   applied tests/tenancy/policies/00-roles.sql");

    // Then every shared per-domain policy, through the SAME applier the harness
    // and the platform bootstrap use (prisma/rls/apply.ts).
    await applyPolicyFiles(owner, [sharedPolicyDir()], (f) =>
      console.log(`[sandbox]   applied prisma/rls/${f.file}`),
    );
  } finally {
    await owner.$disconnect();
  }

  // 4. seed
  console.log("[sandbox] seeding tenants");
  execSync("npx tsx scripts/seed-sandbox.ts", {
    env: { ...process.env, SANDBOX_OWNER_URL: OWNER_URL },
    stdio: "inherit",
  });

  console.log("\n✅ Sandbox ready. Start it with:  npm run dev:sandbox");
  console.log("   Acme:   http://acme.localhost:3114    (admin@acme.test / sandbox123)");
  console.log("   Globex: http://globex.localhost:3114  (admin@globex.test / sandbox123)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
