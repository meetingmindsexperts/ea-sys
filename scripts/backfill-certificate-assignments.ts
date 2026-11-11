/**
 * Catch-up backfill for certificate assignments (Nov 11, 2026).
 *
 * Migration 20261111120000_certificate_assignment turned every certificate
 * tag into CertificateAssignment rows. The migration is applied a few minutes
 * BEFORE the new code serves, and the old code goes on reading tags until
 * then: a tag added in that window (an attendance import run mid-deploy)
 * never became a row, and the new code no longer reads the tag.
 *
 * This runs the SAME statements again. It does not carry its own copy: it
 * reads them out of the migration file, between the BACKFILL markers, so the
 * two cannot drift. Each statement is ON CONFLICT DO NOTHING with a derived
 * id, so a re-run inserts only what is missing and changes nothing else.
 *
 * It writes rows only. It does NOT hand anyone back to the survey auto-issue
 * sweep, so running it never sends a certificate: a person it adds who has
 * already answered the survey shows on the Recipients report as "Ready to
 * issue", for someone to send.
 *
 * Run once after the deploy that ships the migration:
 *
 *   docker exec ea-sys-worker npx tsx scripts/backfill-certificate-assignments.ts          # dry run
 *   docker exec ea-sys-worker npx tsx scripts/backfill-certificate-assignments.ts --write  # apply
 *
 * The dry run executes the statements inside a transaction and rolls it back,
 * so the count it prints is exact.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";

export const BACKFILL_MIGRATION = "prisma/migrations/20261111120000_certificate_assignment/migration.sql";
const BEGIN = "-- BACKFILL:BEGIN";
const END = "-- BACKFILL:END";

/** The backfill statements, in order, read from the migration file. */
export function readBackfillStatements(sql: string): string[] {
  const start = sql.indexOf(BEGIN);
  const end = sql.indexOf(END);
  if (start < 0 || end < start) throw new Error(`BACKFILL markers not found in ${BACKFILL_MIGRATION}`);
  return sql
    .slice(start + BEGIN.length, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

class Rollback extends Error {}

async function main() {
  const write = process.argv.includes("--write");
  const statements = readBackfillStatements(readFileSync(path.resolve(process.cwd(), BACKFILL_MIGRATION), "utf8"));
  if (statements.some((s) => !s.startsWith('INSERT INTO "CertificateAssignment"') || !s.endsWith("ON CONFLICT DO NOTHING"))) {
    throw new Error("Refusing: the backfill block holds something other than its idempotent inserts");
  }

  // The plain client, as the other one-off backfills use: this is a catch-up
  // for the master database, where row-level security is not enforced (the
  // platform instance is built from the migration chain and has no tags to copy).
  const before = await db.certificateAssignment.count();
  let inserted = 0;
  try {
    await db.$transaction(async (tx) => {
      for (const statement of statements) inserted += await tx.$executeRawUnsafe(statement);
      if (!write) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  const after = await db.certificateAssignment.count();

  console.log(
    JSON.stringify({ mode: write ? "write" : "dry-run", statements: statements.length, before, inserted, after }, null, 2),
  );
  if (!write && inserted > 0) console.log(`\n${inserted} row(s) would be added. Re-run with --write to add them.`);
  if (inserted === 0) console.log("\nNothing to add: every tag already has its assignment.");
}

// Only when run as a script: the tests import readBackfillStatements.
if (process.argv[1]?.endsWith("backfill-certificate-assignments.ts")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
