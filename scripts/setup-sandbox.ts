/**
 * Provision the LOCAL multi-tenant RLS sandbox — see docs/SANDBOX.md.
 *
 * Creates a dedicated `sandbox` database INSIDE the existing tenancy Postgres
 * container (so `npm run test:tenancy` — which wipes the `tenancy` db — never
 * clobbers it), then:
 *   1. CREATE DATABASE sandbox (idempotent)
 *   2. prisma db push (full schema, OWNER connection)
 *   3. apply the role split (tests/tenancy/policies/00-roles.sql) + EVERY
 *      per-domain policy in prisma/rls/*.sql — deliberately NOT the Event pilot
 *      policy (tests/tenancy/policies/10-event-rls.sql): Event is un-swept, so
 *      RLS on it would fail-close the whole dashboard.
 *   4. seed two tenants (scripts/seed-sandbox.ts)
 *
 * The app then connects as the non-owner `app_user` (RLS enforces) via
 * `npm run dev:sandbox`. LOCAL ONLY — never a prod database.
 *
 * Prereq: the tenancy container must be up —
 *   docker compose --profile tenancy up -d
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

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

  // 3. role split + domain policies (NOT the Event pilot policy)
  console.log("[sandbox] applying role split + domain RLS policies");
  const rlsDir = path.resolve(process.cwd(), "prisma/rls");
  const files = [
    path.resolve(process.cwd(), "tests/tenancy/policies/00-roles.sql"),
    ...readdirSync(rlsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => path.join(rlsDir, f)),
  ];
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  try {
    for (const file of files) {
      const sql = readFileSync(file, "utf8");
      for (const statement of splitSql(sql)) {
        await owner.$executeRawUnsafe(statement);
      }
      console.log(`[sandbox]   applied ${path.relative(process.cwd(), file)}`);
    }
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

/** Split SQL into statements on top-level semicolons (respects $$ blocks). */
function splitSql(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < withoutComments.length; i++) {
    if (withoutComments.startsWith("$$", i)) {
      inDollar = !inDollar;
      current += "$$";
      i += 1;
      continue;
    }
    const ch = withoutComments[i];
    if (ch === ";" && !inDollar) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
