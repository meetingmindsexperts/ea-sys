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
 * It never puts back someone staff REMOVED after the deploy (review of
 * 631e95bd, M3). The tags are never cleared, so the statements alone cannot
 * tell "never copied" from "copied, then removed on purpose". Each removal is
 * an audit row (CERTIFICATE_UNASSIGNED, naming the people up to 200); a new
 * row for a removed (template, person) is taken out again before commit, and
 * for a removal too large to name everyone, every new row for that template
 * is. The output lists what was held back.
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
import type { Prisma } from "@prisma/client";
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

type Tx = Prisma.TransactionClient;

/**
 * (template, person) pairs staff took off a list, from the unassign audit
 * rows; and the templates whose removal named fewer people than it removed
 * (the audit keeps at most 200 ids), where nobody can be put back safely.
 */
export function removedPairsFrom(
  audits: ReadonlyArray<{ entityId: string | null; changes: unknown }>,
): { pairs: Set<string>; unnamed: Set<string> } {
  const pairs = new Set<string>();
  const unnamed = new Set<string>();
  for (const audit of audits) {
    if (!audit.entityId) continue;
    const changes = (audit.changes ?? {}) as { registrationIds?: unknown; speakerIds?: unknown; removed?: unknown };
    const ids = [changes.registrationIds, changes.speakerIds]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((id): id is string => typeof id === "string");
    if (typeof changes.removed === "number" && changes.removed > ids.length) unnamed.add(audit.entityId);
    for (const id of ids) pairs.add(`${audit.entityId}|${id}`);
  }
  return { pairs, unnamed };
}

/** Take back the rows this run added for people staff removed. Returns how many. */
async function holdBackRemoved(tx: Tx, existingIds: ReadonlySet<string>): Promise<number> {
  const audits = await tx.auditLog.findMany({
    where: { action: "CERTIFICATE_UNASSIGNED", entityType: "CertificateTemplate" },
    select: { entityId: true, changes: true },
  });
  if (audits.length === 0) return 0;
  const { pairs, unnamed } = removedPairsFrom(audits);
  const rows = await tx.certificateAssignment.findMany({
    select: { id: true, certificateTemplateId: true, registrationId: true, speakerId: true },
  });
  const heldBack = rows.filter((r) => {
    if (existingIds.has(r.id)) return false;
    const person = r.registrationId ?? r.speakerId ?? "";
    return unnamed.has(r.certificateTemplateId) || pairs.has(`${r.certificateTemplateId}|${person}`);
  });
  if (heldBack.length === 0) return 0;
  await tx.certificateAssignment.deleteMany({ where: { id: { in: heldBack.map((r) => r.id) } } });
  return heldBack.length;
}

/**
 * Run the backfill statements in one transaction and take back what staff
 * removed. `write: false` rolls everything back, so the counts are exact and
 * nothing changes. Exported for the real-Postgres test.
 */
export async function applyBackfill(
  statements: readonly string[],
  opts: { write: boolean },
): Promise<{ inserted: number; heldBack: number }> {
  if (statements.some((s) => !s.startsWith('INSERT INTO "CertificateAssignment"') || !s.endsWith("ON CONFLICT DO NOTHING"))) {
    throw new Error("Refusing: the backfill block holds something other than its idempotent inserts");
  }
  let inserted = 0;
  let heldBack = 0;
  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.certificateAssignment.findMany({ select: { id: true } });
      const existingIds = new Set(existing.map((r) => r.id));
      for (const statement of statements) inserted += await tx.$executeRawUnsafe(statement);
      heldBack = await holdBackRemoved(tx, existingIds);
      inserted -= heldBack;
      if (!opts.write) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return { inserted, heldBack };
}

async function main() {
  const write = process.argv.includes("--write");
  const statements = readBackfillStatements(readFileSync(path.resolve(process.cwd(), BACKFILL_MIGRATION), "utf8"));

  // The plain client, as the other one-off backfills use: this is a catch-up
  // for the master database, where row-level security is not enforced (the
  // platform instance is built from the migration chain and has no tags to copy).
  const before = await db.certificateAssignment.count();
  const { inserted, heldBack } = await applyBackfill(statements, { write });
  const after = await db.certificateAssignment.count();

  console.log(
    JSON.stringify({ mode: write ? "write" : "dry-run", statements: statements.length, before, inserted, heldBack, after }, null, 2),
  );
  if (!write && inserted > 0) console.log(`\n${inserted} row(s) would be added. Re-run with --write to add them.`);
  if (heldBack > 0) console.log(`\n${heldBack} row(s) held back: staff removed those people after the deploy.`);
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
