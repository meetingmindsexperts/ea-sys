/**
 * Applying the shared RLS policy files — the ONE implementation.
 *
 * Two callers, deliberately:
 *   1. tests/tenancy/global-setup.ts  — the isolation harness, every CI run
 *   2. scripts/bootstrap-rls.ts       — a real database (local rehearsal rig,
 *                                       then the platform instance)
 *
 * They must apply byte-identical SQL or the harness stops being evidence about
 * the thing that actually runs. Hence one module rather than two copies of a
 * statement splitter (the no-cross-caller-duplication rule).
 *
 * This is OPS TOOLING, not app code. It imports node:fs and must never be
 * reachable from a route or a client component. It lives beside the .sql files
 * it applies for that reason.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Minimal surface so this module never depends on a concrete Prisma client. */
export type SqlExecutor = {
  $executeRawUnsafe(query: string): Promise<number>;
};

export interface PolicyFile {
  /** Directory basename, for logging: "rls" or "policies". */
  dir: string;
  /** Filename, e.g. "contact.sql". */
  file: string;
  statements: string[];
}

/**
 * Split SQL into statements on top-level semicolons, keeping `$$ … $$` blocks
 * intact.
 *
 * Prisma cannot run a multi-statement string through $executeRaw, and several
 * policy files wrap idempotency guards in DO blocks whose bodies contain
 * semicolons. Splitting naively on `;` would cut those in half and the error
 * would point at a fragment rather than the real problem.
 */
export function splitSql(sql: string): string[] {
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

/**
 * Read every .sql file in the given directories, in directory order then
 * filename order.
 *
 * A missing directory is a CONTRACT error, not an ENOENT. Git does not track
 * empty directories, so moving the last .sql out of prisma/rls/ would otherwise
 * crash a fresh checkout with a message that reads like broken tooling instead
 * of a broken invariant.
 */
export function readPolicyFiles(dirs: readonly string[]): PolicyFile[] {
  const out: PolicyFile[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      throw new Error(
        `${dir} is missing. These SQL directories are load-bearing: prisma/rls ` +
          `holds the SHARED per-domain RLS policies and prisma/platform holds ` +
          `platform-only constraints that cannot live in the migration chain. ` +
          `Both are applied by the isolation harness AND the platform ` +
          `bootstrap. Restore the dir/files.`,
      );
    }
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      out.push({
        dir: path.basename(dir),
        file,
        statements: splitSql(readFileSync(path.join(dir, file), "utf8")),
      });
    }
  }

  return out;
}

/**
 * Apply the policy files over an OWNER connection.
 *
 * Must be the direct (non-pooled) connection: these are DDL statements, and a
 * transaction pooler can reassign backends between them.
 *
 * Every policy file is idempotent by construction (`ALTER TABLE … ENABLE`,
 * `DROP POLICY IF EXISTS` then `CREATE POLICY`), so re-running is safe. Note
 * the accepted window this implies on a LIVE database: DROP and CREATE are
 * separate autocommit statements, so a re-apply has a brief moment where RLS is
 * enabled with no policy. That direction is default-DENY — a blink of zero
 * rows, never a leak.
 */
export async function applyPolicyFiles(
  client: SqlExecutor,
  dirs: readonly string[],
  onFile?: (file: PolicyFile) => void,
): Promise<PolicyFile[]> {
  const files = readPolicyFiles(dirs);

  for (const file of files) {
    for (const statement of file.statements) {
      await client.$executeRawUnsafe(statement);
    }
    onFile?.(file);
  }

  return files;
}

/** The shared policy directory both consumers apply. */
export function sharedPolicyDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "prisma/rls");
}

/**
 * Platform-only SQL: constraints that are correct for the platform instance and
 * WRONG for master, so they cannot go in schema.prisma or the migration chain.
 *
 * One repo, one image, one schema (MULTI_TENANCY.md §0 guardrail 1) means a
 * Prisma migration runs on both deploy targets. Anything true of only one of
 * them therefore has to be applied out-of-band, the same way the RLS policies
 * are. Today this holds the item-6 per-tenant email uniqueness; see
 * prisma/platform/010-user-identity.sql for the full reasoning.
 *
 * Applied by scripts/bootstrap-rls.ts and by the isolation harness — the
 * harness deliberately runs the SAME files, because a constraint proven against
 * a hand-written copy is evidence about the copy.
 */
export function platformOnlyDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "prisma/platform");
}
