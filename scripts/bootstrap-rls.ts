/**
 * Turn a database into a tenant-isolated one: the non-owner app role, its
 * grants, every shared RLS policy, and a pre-flight that proves enforcement is
 * real before anything is asked to serve traffic.
 *
 * WHY THIS EXISTS
 * ---------------
 * `prisma/rls/*.sql` has 39 policy files that have only ever run inside the
 * isolation harness's Docker container. This is the production-grade applier:
 * the same SQL, applied the same way (prisma/rls/apply.ts is shared with the
 * harness), against a real database.
 *
 * TWO TARGETS, IN THIS ORDER
 * --------------------------
 *   1. The LOCAL rehearsal rig (`ea_sys_prod_local`, a full prod-data copy).
 *      Prove the app BOOTS AND RUNS under RLS_SET_LOCAL=1 against realistic
 *      data before spending money on infrastructure. This is where the
 *      surprises are: an unwrapped query under RLS returns ZERO ROWS SILENTLY,
 *      not an error, so the failure mode is a blank page, not a stack trace.
 *   2. The PLATFORM instance's fresh database, at birth.
 *
 * It is NEVER a prisma migration, and it must never touch master. Master keeps
 * a database with zero RLS objects — auditable via pg_policies, no false sense
 * of enforcement, no latent outage if master's connection role ever changes.
 * See the header of prisma/rls/contact.sql for the full reasoning.
 *
 * ENFORCEMENT COMES FROM THE CONNECTION ROLE, NOT THE POLICIES
 * ------------------------------------------------------------
 * The policy files deliberately omit FORCE ROW LEVEL SECURITY, so a table's
 * OWNER bypasses every one of them. That is the single silent hole in the whole
 * design: apply all 39 files, connect with Supabase's default (owner) string,
 * and you get a database that looks isolated and is not. This script's verify
 * step and the boot tripwire (src/lib/tenant/rls-assert.ts) exist for exactly
 * that hole, and they share one query so they cannot disagree about what
 * "enforced" means.
 *
 * USAGE
 *   npx tsx scripts/bootstrap-rls.ts --verify-only      # report, change nothing
 *   npx tsx scripts/bootstrap-rls.ts --dry-run          # print the plan
 *   RLS_APP_USER_PASSWORD=… npx tsx scripts/bootstrap-rls.ts
 *
 * Reads DIRECT_URL (the OWNER, non-pooled connection). DDL through a
 * transaction pooler can land on different backends between statements.
 *
 * Idempotent throughout: re-running is the normal way to apply a new domain's
 * policy file.
 */
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import {
  applyPolicyFiles,
  readPolicyFiles,
  platformOnlyDir,
  sharedPolicyDir,
} from "../prisma/rls/apply";
import { listPoliciedTables } from "../src/lib/tenant/rls-assert";

/** master prod's Supabase project ref — the one database this must never touch. */
const MASTER_PROD_MARKER = "nifaqvgnfwddgsusxapy";

const DEFAULT_ROLE = "app_user";

/**
 * A table with NO policy, used to prove the grants landed.
 *
 * Deliberately not a policied one: a policied table returns zero rows for a
 * correctly-grantedrole with no tenant GUC set, which is indistinguishable
 * from "permission denied" if you only look at the row count. Organization
 * carries no policy (it is the tenant list itself), so a successful read there
 * means grants, and a failure means grants — unambiguous either way.
 */
const GRANT_PROBE_TABLE = "Organization";

function fail(message: string): never {
  console.error(`\n✋ ${message}\n`);
  process.exit(1);
}

/**
 * Role names land in an identifier position where a bind parameter is not
 * allowed, so the value is validated rather than escaped. Postgres unquoted
 * identifier rules, which is what any real app role looks like.
 */
function assertSafeRoleName(role: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    fail(
      `Role name ${JSON.stringify(role)} is not a plain lowercase identifier. ` +
        `Use something like "app_user".`,
    );
  }
}

interface Args {
  role: string;
  dryRun: boolean;
  verifyOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { role: DEFAULT_ROLE, dryRun: false, verifyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verify-only") args.verifyOnly = true;
    else if (a === "--role") {
      const v = argv[++i];
      if (!v) fail("--role needs a value.");
      args.role = v;
    } else if (a.startsWith("--role=")) args.role = a.slice("--role=".length);
    else fail(`Unknown argument ${JSON.stringify(a)}.`);
  }
  assertSafeRoleName(args.role);
  return args;
}

async function main() {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env") });

  const args = parseArgs(process.argv.slice(2));

  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    fail("DIRECT_URL (preferred) or DATABASE_URL must be set to the OWNER connection.");
  }
  if (!process.env.DIRECT_URL) {
    console.warn(
      "⚠  DIRECT_URL is unset, falling back to DATABASE_URL. If that is a pooled\n" +
        "   (pgbouncer) connection, DDL may fail — point DIRECT_URL at the direct port.",
    );
  }

  // INC-002 class guard. The platform's own database has a different project
  // ref, so this refuses master specifically rather than "production".
  if (url.includes(MASTER_PROD_MARKER) && process.env.ALLOW_PROD_DB !== "1") {
    fail(
      `REFUSING: the connection points at MASTER production (Supabase project ` +
        `${MASTER_PROD_MARKER}).\n   Master deliberately runs with ZERO RLS objects — ` +
        `applying policies there with an owner\n   connection string would enable RLS ` +
        `with no enforcement and no way to tell.\n   Target the local rehearsal DB or the ` +
        `platform instance instead.`,
    );
  }

  const redacted = url.replace(/:\/\/[^@]*@/, "://***@");
  console.log(`\nTarget: ${redacted}`);
  console.log(`App role: ${args.role}\n`);

  // Two directories, applied in order: the shared RLS policies, then the
  // platform-only constraints that cannot live in the migration chain because
  // master and the platform share one schema.prisma (see platformOnlyDir).
  const policyDir = sharedPolicyDir();
  const platformDir = platformOnlyDir();
  const files = readPolicyFiles([policyDir, platformDir]);

  if (args.dryRun) {
    console.log(`Would apply ${files.length} SQL files from prisma/rls + prisma/platform:`);
    for (const f of files) console.log(`  ${f.file}  (${f.statements.length} statements)`);
    console.log(`\nWould ensure role "${args.role}" exists and holds table/sequence grants.`);
    console.log("Nothing was changed (--dry-run).\n");
    return;
  }

  const owner = new PrismaClient({ datasourceUrl: url });

  try {
    if (!args.verifyOnly) {
      await ensureRole(owner, args.role);
      await grantToRole(owner, args.role);

      console.log(`Applying ${files.length} policy files…`);
      await applyPolicyFiles(owner, [policyDir, platformDir], (f) => console.log(`  ✓ ${f.dir}/${f.file}`));
      console.log();
    }

    await verify(owner, args.role);
  } finally {
    await owner.$disconnect();
  }
}

/**
 * Create the app role if it is missing.
 *
 * The password is required only when the role does not yet exist, so a re-run
 * against a provisioned database needs no secret in the environment at all.
 *
 * Values are passed through transaction-local GUCs and interpolated by
 * `format(%I, %L)` inside the DO block, which is the injection-safe way to get
 * runtime values into DDL: bind parameters are not permitted in a CREATE ROLE.
 */
async function ensureRole(owner: PrismaClient, role: string): Promise<void> {
  const exists = await owner.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS "ok"
  `;

  if (exists[0]?.ok) {
    console.log(`Role "${role}" already exists — leaving its password untouched.`);
    return;
  }

  const password = process.env.RLS_APP_USER_PASSWORD;
  if (!password) {
    fail(
      `Role "${role}" does not exist and RLS_APP_USER_PASSWORD is unset.\n` +
        `   Either set it for this command, or create the role yourself (Supabase\n` +
        `   SQL editor is fine) and re-run — this script only creates what is missing.`,
    );
  }

  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('bootstrap.role_name', ${role}, true)`;
    await tx.$executeRaw`SELECT set_config('bootstrap.role_pw', ${password}, true)`;
    await tx.$executeRawUnsafe(`
      DO $$
      DECLARE
        r text := current_setting('bootstrap.role_name');
        p text := current_setting('bootstrap.role_pw');
      BEGIN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', r, p);
      END
      $$;
    `);
  });

  console.log(`Created role "${role}".`);
  console.log(
    "   Note: the password appears briefly in the server's statement logs, as it\n" +
      "   would for any CREATE ROLE. Rotate it later if that matters to you.",
  );
}

/**
 * Grant the app role what an application needs and nothing more.
 *
 * No DDL rights, deliberately: the app role must not be able to ALTER a table
 * or DROP a policy. Migrations run as the owner.
 *
 * ALTER DEFAULT PRIVILEGES is the load-bearing line — without it every table
 * added by a future migration is invisible to the app role, and the symptom is
 * a permission error on one endpoint some weeks later.
 */
async function grantToRole(owner: PrismaClient, role: string): Promise<void> {
  const statements = [
    `GRANT USAGE ON SCHEMA public TO "${role}"`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${role}"`,
  ];
  for (const s of statements) await owner.$executeRawUnsafe(s);
  console.log(`Granted table + sequence privileges to "${role}" (no DDL rights).`);
}

/**
 * Prove enforcement, from the app role's point of view.
 *
 * `SET LOCAL ROLE` inside a transaction is what makes this meaningful:
 * row_security_active() answers for the CURRENT role, and the owner would
 * always answer false. Running it under the app role asks the question the
 * running application will be asking.
 *
 * This is a PRE-FLIGHT. The real gate is the boot tripwire, which runs the same
 * query over the app's own connection string every time it starts.
 */
async function verify(owner: PrismaClient, role: string): Promise<void> {
  const result = await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);

    // Grants probe first: a role with no grants fails everything downstream,
    // and "permission denied" is a much clearer diagnosis than "zero rows".
    let grantsOk = true;
    let grantError = "";
    try {
      await tx.$queryRawUnsafe(`SELECT 1 FROM "${GRANT_PROBE_TABLE}" LIMIT 1`);
    } catch (e) {
      grantsOk = false;
      grantError = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }

    const tables = await listPoliciedTables(tx);
    return { grantsOk, grantError, tables };
  });

  const { grantsOk, grantError, tables } = result;

  if (!grantsOk) {
    fail(
      `Role "${role}" cannot read "${GRANT_PROBE_TABLE}": ${grantError}\n` +
        `   The grants did not land. Re-run without --verify-only.`,
    );
  }

  if (tables.length === 0) {
    fail(
      "No RLS policies exist on this database at all.\n" +
        "   Re-run without --verify-only to apply prisma/rls/*.sql + prisma/platform/*.sql.",
    );
  }

  const bypassed = tables.filter((t) => !t.active);

  console.log(`Policied tables: ${tables.length}`);
  console.log(`RLS active for "${role}" on: ${tables.length - bypassed.length}/${tables.length}`);

  if (bypassed.length > 0) {
    fail(
      `Row-level security is NOT in force for "${role}" on:\n` +
        `     ${bypassed.map((t) => t.table).join(", ")}\n\n` +
        `   That role bypasses RLS — it owns those tables, or is a superuser, or holds\n` +
        `   BYPASSRLS. Every policy silently no-ops and every tenant can read every\n` +
        `   other tenant's rows. This is the exact hole the design warns about.\n` +
        `   Point the app at a NON-owner role.`,
    );
  }

  console.log("\n✓ Enforcement verified for the app role.\n");
  console.log("Next: point the application's DATABASE_URL at this role and set");
  console.log("RLS_SET_LOCAL=1. The boot tripwire re-checks the above on every start");
  console.log("and refuses to serve if it ever stops being true.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
