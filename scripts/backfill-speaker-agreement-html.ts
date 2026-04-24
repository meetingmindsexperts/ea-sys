/**
 * One-time backfill — seed `Event.speakerAgreementHtml` with the
 * project default for any event that has neither inline HTML nor a
 * .docx template configured. Those events would otherwise return a
 * 400 on agreement-email sends.
 *
 * Safe to re-run — scoped WHERE filter only touches rows that are
 * still NULL in both columns.
 *
 * Usage:
 *   npx tsx scripts/backfill-speaker-agreement-html.ts          # dry run
 *   npx tsx scripts/backfill-speaker-agreement-html.ts --write  # apply
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { DEFAULT_SPEAKER_AGREEMENT_HTML } from "../src/lib/default-terms";

const write = process.argv.includes("--write");
const db = new PrismaClient();

async function main() {
  const targets = await db.event.findMany({
    where: {
      speakerAgreementHtml: null,
      // JSON-nullable column: must use Prisma.DbNull to filter for SQL NULL.
      speakerAgreementTemplate: { equals: Prisma.DbNull },
    },
    select: { id: true, slug: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${targets.length} events needing backfill:`);
  for (const e of targets) {
    console.log(`  ${e.createdAt.toISOString().slice(0, 10)}  ${e.slug.padEnd(40)}  ${e.name}`);
  }

  if (!write) {
    console.log();
    console.log("Dry run. Re-run with --write to apply.");
    process.exit(0);
  }

  if (targets.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const result = await db.event.updateMany({
    where: {
      id: { in: targets.map((t) => t.id) },
      // Defense-in-depth: re-check the NULL predicate at write time in
      // case a parallel organizer just set HTML on an event between
      // our read and write.
      speakerAgreementHtml: null,
    },
    data: { speakerAgreementHtml: DEFAULT_SPEAKER_AGREEMENT_HTML },
  });

  console.log(`\nUpdated ${result.count} event(s).`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
