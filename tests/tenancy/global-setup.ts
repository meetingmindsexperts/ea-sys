/**
 * Tenant-isolation harness provisioning (mirrors e2e/global-setup.ts):
 *   1. prisma db push against the OWNER connection (TENANCY_DIRECT_URL —
 *      raw Postgres, superuser/owner role)
 *   2. apply tests/tenancy/policies/*.sql in filename order over the owner
 *      connection: the app_user role split, then the PILOT Event RLS policy
 *      (harness-only — real RLS migrations are Phase-2 per-domain work)
 *   3. seed two tenants (prisma/seed-tenancy.ts, owner connection)
 *
 * The tests themselves connect as the NON-owner app_user through pgbouncer
 * (TENANCY_DATABASE_URL) — owners bypass RLS, so the two-role split is what
 * makes the policy actually apply. See tests/tenancy/policies/00-roles.sql.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

export default async function globalSetup() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const direct = process.env.TENANCY_DIRECT_URL;
  const pooled = process.env.TENANCY_DATABASE_URL;
  if (!direct || !pooled) {
    throw new Error(
      "TENANCY_DIRECT_URL (owner, raw :5432) and TENANCY_DATABASE_URL (app_user via pgbouncer :6432) " +
        "must be set. Locally: docker compose --profile tenancy up -d, then see .env.example.",
    );
  }

  const env = { ...process.env, DATABASE_URL: direct, DIRECT_URL: direct };

  console.log("[tenancy:setup] syncing schema to the harness DB");
  execSync("npx prisma db push --skip-generate", { env, stdio: "inherit" });

  console.log("[tenancy:setup] applying role split + pilot RLS policies");
  const owner = new PrismaClient({ datasourceUrl: direct });
  try {
    const policiesDir = path.resolve(process.cwd(), "tests/tenancy/policies");
    for (const file of readdirSync(policiesDir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(path.join(policiesDir, file), "utf8");
      // Prisma can't run multi-statement strings via $executeRaw; split on
      // statement boundaries while keeping DO $$ ... $$ blocks intact.
      for (const statement of splitSql(sql)) {
        await owner.$executeRawUnsafe(statement);
      }
      console.log(`[tenancy:setup]   applied ${file}`);
    }
  } finally {
    await owner.$disconnect();
  }

  console.log("[tenancy:setup] seeding two tenants");
  execSync("npx tsx prisma/seed-tenancy.ts", { env, stdio: "inherit" });
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
