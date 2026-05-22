/**
 * One-time backfill — generate a `qrCode` for any Registration that has
 * none. Legacy rows created before the auto-generate logic (or via paths
 * that skipped it) have `qrCode = null`, so their badge / on-screen barcode
 * shows "Not set" with no scannable image. This assigns each a unique
 * Code 128 value using the same `generateBarcode()` the live paths use.
 *
 * Rows that already have a `qrCode` OR a `dtcmBarcode` are left untouched
 * (a DTCM-imported row is already scannable via its own barcode). Safe to
 * re-run — the WHERE filter only matches rows still missing both.
 *
 * Each value is written with a per-row uniqueness retry: `qrCode` is
 * `@unique`, and `generateBarcode()` embeds Date.now() + random, so a
 * collision is astronomically unlikely — but we catch P2002 and retry a
 * few times rather than abort the whole batch on one unlucky row.
 *
 * Usage:
 *   npx tsx scripts/backfill-registration-qrcodes.ts          # dry run
 *   npx tsx scripts/backfill-registration-qrcodes.ts --write  # apply
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { generateBarcode } from "../src/lib/utils";

const write = process.argv.includes("--write");
const db = new PrismaClient();

const MAX_COLLISION_RETRIES = 5;

async function main() {
  const targets = await db.registration.findMany({
    where: {
      qrCode: null,
      dtcmBarcode: null,
    },
    select: {
      id: true,
      serialId: true,
      createdAt: true,
      event: { select: { slug: true } },
      attendee: { select: { email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${targets.length} registrations with no barcode:`);
  for (const r of targets.slice(0, 50)) {
    console.log(
      `  ${r.createdAt.toISOString().slice(0, 10)}  ${(r.event?.slug ?? "—").padEnd(28)}  #${String(r.serialId ?? "—").padStart(4)}  ${r.attendee?.email ?? ""}`,
    );
  }
  if (targets.length > 50) console.log(`  … and ${targets.length - 50} more`);

  if (!write) {
    console.log();
    console.log("Dry run. Re-run with --write to apply.");
    process.exit(0);
  }

  let updated = 0;
  let failed = 0;
  for (const r of targets) {
    let assigned = false;
    for (let attempt = 0; attempt < MAX_COLLISION_RETRIES && !assigned; attempt++) {
      try {
        await db.registration.update({
          where: { id: r.id },
          data: { qrCode: generateBarcode() },
        });
        assigned = true;
        updated++;
      } catch (err) {
        // P2002 = unique constraint violation on qrCode → retry with a
        // fresh value. Anything else → log and move on (don't abort batch).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          continue;
        }
        failed++;
        console.error(`  FAILED ${r.id}: ${err instanceof Error ? err.message : "unknown"}`);
        break;
      }
    }
    if (!assigned && updated + failed < targets.length) {
      // Exhausted retries on collisions (effectively impossible).
      failed++;
      console.error(`  FAILED ${r.id}: could not assign a unique qrCode after ${MAX_COLLISION_RETRIES} attempts`);
    }
  }

  console.log();
  console.log(`Done. Updated ${updated}, failed ${failed}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
