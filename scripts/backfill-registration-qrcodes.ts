/**
 * Backfill: give an entry barcode (`qrCode`) to every in-person, not
 * cancelled registration that has none.
 *
 * First written May 22, 2026 for legacy rows. Revised Oct 19, 2026, when
 * "Import from Contacts" turned out never to mint one (49 live rows on prod,
 * 4 of them on BHS2026 five days before the event): those people could not be
 * scanned at check-in and their badge printed without a barcode.
 *
 * Only in-person, not cancelled rows (a virtual attendee has nothing to scan,
 * the same rule as `needsQrCode`; a cancelled one never comes to the door).
 * A row with a DTCM compliance code is included: the ENTRY barcode is always
 * `qrCode`, the DTCM code is a separate compliance value.
 *
 * Safe to re-run: each write is guarded on `qrCode: null`, so a barcode set
 * meanwhile (or by an earlier run) is never replaced. `qrCode` is @unique and
 * `generateBarcode()` is time + random, so a collision is astronomically
 * unlikely; a P2002 retries with a fresh value. Every assignment is audited
 * (BARCODE_BACKFILL), so the Activity page shows who got one and when.
 *
 * Usage (on the box: docker exec ea-sys-worker npx tsx scripts/backfill-registration-qrcodes.ts …):
 *   npx tsx scripts/backfill-registration-qrcodes.ts                     # dry run, every event
 *   npx tsx scripts/backfill-registration-qrcodes.ts --event BHS2026     # dry run, one event (slug)
 *   npx tsx scripts/backfill-registration-qrcodes.ts --event BHS2026 --write
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { generateBarcode } from "../src/lib/utils";

const write = process.argv.includes("--write");
const eventArg = process.argv.indexOf("--event");
const eventSlug = eventArg > -1 ? process.argv[eventArg + 1] : undefined;
const db = new PrismaClient();

const MAX_COLLISION_RETRIES = 5;

/** Assigns a barcode to one row unless it has one by now. "set" | "had-one" | "failed". */
async function assign(id: string): Promise<"set" | "had-one" | "failed"> {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    try {
      const res = await db.registration.updateMany({ where: { id, qrCode: null }, data: { qrCode: generateBarcode() } });
      return res.count === 1 ? "set" : "had-one";
    } catch (err) {
      // P2002 = another row holds that value: retry with a fresh one.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      console.error(`  FAILED ${id}: ${err instanceof Error ? err.message : "unknown"}`);
      return "failed";
    }
  }
  console.error(`  FAILED ${id}: no unique barcode after ${MAX_COLLISION_RETRIES} attempts`);
  return "failed";
}

async function main() {
  if (eventArg > -1 && !eventSlug) {
    console.error("--event needs an event slug, e.g. --event BHS2026");
    process.exit(1);
  }
  const targets = await db.registration.findMany({
    where: {
      qrCode: null,
      attendanceMode: "IN_PERSON",
      status: { not: "CANCELLED" },
      ...(eventSlug ? { event: { slug: eventSlug } } : {}),
    },
    select: {
      id: true,
      serialId: true,
      status: true,
      createdSource: true,
      eventId: true,
      organizationId: true,
      createdAt: true,
      event: { select: { slug: true } },
      attendee: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: [{ event: { startDate: "asc" } }, { createdAt: "asc" }],
  });

  console.log(`${targets.length} in-person registration(s) with no entry barcode${eventSlug ? ` on ${eventSlug}` : ""}:`);
  for (const r of targets.slice(0, 100)) {
    const name = `${r.attendee?.firstName ?? ""} ${r.attendee?.lastName ?? ""}`.trim();
    console.log(
      `  ${(r.event?.slug ?? "-").padEnd(30)} #${String(r.serialId ?? "-").padStart(4)}  ${r.status.padEnd(10)} ${String(r.createdSource ?? "-").padEnd(16)} ${name} <${r.attendee?.email ?? ""}>`,
    );
  }
  if (targets.length > 100) console.log(`  ... and ${targets.length - 100} more`);

  if (!write) {
    console.log("\nDry run: nothing changed. Re-run with --write to apply.");
    return;
  }

  const counts = { set: 0, "had-one": 0, failed: 0 };
  for (const r of targets) {
    const result = await assign(r.id);
    counts[result]++;
    if (result !== "set") continue;
    await db.auditLog
      .create({
        data: {
          eventId: r.eventId,
          organizationId: r.organizationId,
          action: "BARCODE_BACKFILL",
          entityType: "Registration",
          entityId: r.id,
          changes: { reason: "in-person registration had no entry barcode", source: "script:backfill-registration-qrcodes" },
        },
      })
      .catch((err: unknown) => console.error(`  audit failed for ${r.id}: ${err instanceof Error ? err.message : "unknown"}`));
  }

  console.log(`\nDone. Barcode set: ${counts.set}. Already had one by now: ${counts["had-one"]}. Failed: ${counts.failed}.`);
  if (counts.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
