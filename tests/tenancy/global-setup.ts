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
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { applyPolicyFiles, sharedPolicyDir } from "../../prisma/rls/apply";

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
  // NOTE: deliberately WITHOUT --accept-data-loss. If the harness DB has been
  // sitting since before a constraint-adding schema change (e.g. a new
  // @@unique), this push FAILS with "Use the --accept-data-loss flag …". That
  // is the intended outcome: the flag is the INC-002 footgun, and hard-coding
  // it here would turn a mis-set TENANCY_DIRECT_URL into silent data loss.
  //
  // The harness DB holds ONLY throwaway fixtures, so the fix is to reset it:
  //   docker exec ea-sys-tenancy-db psql -U postgres -d tenancy \
  //     -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  // then re-run `npm run test:tenancy`.
  execSync("npx prisma db push --skip-generate", { env, stdio: "inherit" });

  // NOTE: prisma/platform/*.sql is deliberately NOT applied here, and that is a
  // constraint of THIS harness rather than a doubt about those files.
  //
  // Those files intentionally diverge from schema.prisma — 010-user-identity.sql
  // drops the global User_email_key so an address can exist in two tenants. The
  // `db push` above re-syncs the harness DB to schema.prisma on EVERY run, so
  // applying them here makes the second run fail: push sees the unique index
  // missing and refuses to re-add it without --accept-data-loss. Observed the
  // first time this was wired, Aug 21 2026.
  //
  // The platform does not have the problem: it runs `prisma migrate deploy`,
  // which skips already-applied migrations by name, so the bootstrap's drop
  // persists across deploys. (Corollary, and the reason guard-db-target.sh
  // matters beyond INC-002: `db push` against the platform would silently
  // restore global email uniqueness and break per-tenant identity.)
  //
  // tests/tenancy/user-identity.test.ts therefore applies those files itself,
  // around its own assertions, and restores the index afterwards.
  console.log("[tenancy:setup] applying role split + RLS policies");
  const owner = new PrismaClient({ datasourceUrl: direct });
  try {
    // Two sources, in order:
    //   1. tests/tenancy/policies/ — harness-specific (role split, the
    //      original Event pilot policy)
    //   2. prisma/rls/            — the SHARED per-domain policy files the
    //      future platform bootstrap applies too (single source of truth;
    //      the harness proving exactly the SQL the platform will run is the
    //      point of reading them from here)
    // Applied by the SHARED applier (prisma/rls/apply.ts), the same one
    // scripts/bootstrap-rls.ts uses on a real database. If the harness applied
    // policies its own way it would stop being evidence about the thing that
    // actually runs.
    await applyPolicyFiles(
      owner,
      [path.resolve(process.cwd(), "tests/tenancy/policies"), sharedPolicyDir()],
      (f) => console.log(`[tenancy:setup]   applied ${f.dir}/${f.file}`),
    );
  } finally {
    await owner.$disconnect();
  }

  console.log("[tenancy:setup] seeding two tenants");
  execSync("npx tsx prisma/seed-tenancy.ts", { env, stdio: "inherit" });
}
