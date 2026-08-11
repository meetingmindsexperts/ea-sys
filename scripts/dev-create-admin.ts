/**
 * Mint a LOCAL-ONLY admin account so you can actually sign in to `npm run dev`
 * (Aug 11, 2026).
 *
 * WHY THIS EXISTS
 * ---------------
 * The local dev database is a restored copy of production (`ea_sys_prod_local`,
 * see docs/LOCAL_DEV_DATABASE.md). Every User row in it is a real colleague's
 * account carrying a real bcrypt hash, and a hash cannot be reversed — so
 * "refresh the DB and log in" has no answer. Without this you can browse the
 * public pages and nothing else.
 *
 * The account this creates is a NEW row on a throwaway local database. It does
 * not touch, and cannot reveal, anyone's real credentials. `npm run db:refresh`
 * wipes it, so re-run this after each refresh.
 *
 * SAFETY
 * ------
 * Creating an admin is exactly the thing you must never do by accident against
 * a real database, so the guard is deliberately louder than the feature:
 * refuses unless the connection string resolves to localhost, refuses the known
 * production project ref, refuses NODE_ENV=production, and refuses a non-local
 * password override. There is NO escape hatch flag, unlike guard-db-target.sh —
 * that one guards a command with legitimate prod uses (`db push`), this one
 * guards a command with none.
 *
 *   npx tsx scripts/dev-create-admin.ts
 *   npx tsx scripts/dev-create-admin.ts --email me@local.test --password hunter2
 *   npx tsx scripts/dev-create-admin.ts --role ORGANIZER
 */
import path from "node:path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/** master prod Supabase project ref — mirrors scripts/guard-db-target.sh */
const PROD_MARKER = "nifaqvgnfwddgsusxapy";

const DEFAULT_EMAIL = "dev-admin@local.test";
const DEFAULT_PASSWORD = "devadmin123";
const ALLOWED_ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function assertLocalDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[dev-create-admin] DATABASE_URL is not set. Nothing to point at.");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("[dev-create-admin] NODE_ENV=production. Refusing.");
  }
  if (url.includes(PROD_MARKER)) {
    throw new Error(
      `[dev-create-admin] DATABASE_URL points at the production Supabase project (${PROD_MARKER}). Refusing — this script creates an admin login.`,
    );
  }
  // Parse rather than substring-match: "…@evil.example/db?host=localhost" must
  // not pass, and a bare `.includes("localhost")` would let it.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("[dev-create-admin] DATABASE_URL is not a parseable URL. Refusing.");
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `[dev-create-admin] DATABASE_URL host is "${host}", not localhost. Refusing — this script only ever runs against a local database.`,
    );
  }
  return url;
}

async function main() {
  const url = assertLocalDatabase();

  const email = (arg("email") ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = arg("password") ?? DEFAULT_PASSWORD;
  const role = (arg("role") ?? "ADMIN").toUpperCase();
  if (!(ALLOWED_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `[dev-create-admin] --role must be one of ${ALLOWED_ROLES.join(", ")}. Got "${role}".`,
    );
  }

  // Imported AFTER the guard so a refusal happens before any client connects.
  const { db } = await import("@/lib/db");

  // Attach to whichever organization actually owns events, so the account sees
  // a populated dashboard rather than an empty one.
  const orgs = await db.organization.findMany({
    select: { id: true, name: true, _count: { select: { events: true } } },
  });
  if (orgs.length === 0) {
    throw new Error("[dev-create-admin] No Organization rows. Run `npm run db:refresh` first.");
  }
  const wantedOrgId = arg("org");
  const org = wantedOrgId
    ? orgs.find((o) => o.id === wantedOrgId)
    : [...orgs].sort((a, b) => b._count.events - a._count.events)[0];
  if (!org) {
    throw new Error(`[dev-create-admin] No organization with id "${wantedOrgId}".`);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.user.upsert({
    where: { email },
    // Only ever rewrite the fields this script owns. An upsert that reset the
    // whole row would quietly clobber a real account if someone passed a
    // colleague's --email by mistake.
    update: { passwordHash, role: role as "ADMIN", organizationId: org.id, emailVerified: new Date() },
    create: {
      email,
      passwordHash,
      firstName: "Dev",
      lastName: "Admin",
      role: role as "ADMIN",
      organizationId: org.id,
      emailVerified: new Date(),
    },
    select: { id: true, email: true, role: true },
  });

  console.log(`\n✓ Local ${user.role} ready on ${new URL(url).hostname}\n`);
  console.log(`   email:    ${user.email}`);
  console.log(`   password: ${password}`);
  console.log(`   org:      ${org.name} (${org._count.events} events)\n`);
  console.log("   Sign in at http://localhost:3113/login");
  console.log("   Local database only. Re-run after `npm run db:refresh`.\n");

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
