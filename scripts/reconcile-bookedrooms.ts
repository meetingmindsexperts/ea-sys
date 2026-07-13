/**
 * Reconcile `RoomType.bookedRooms` against row-truth.
 *
 * WHY THIS EXISTS (accommodation review, July 2026 — H4 + the counter family):
 * `bookedRooms` is a denormalized counter. Several paths used to move it wrongly:
 *
 *   - H4: `Accommodation` cascade-deletes from `Registration`/`Speaker`. A DB
 *     cascade fires NO application code, so deleting a registrant made their
 *     booking vanish while the counter kept counting it — FOREVER. This is the
 *     one that silently jams a hotel block: the room type reports sold out with
 *     an empty room, and every new booking fails NO_ROOMS_AVAILABLE.
 *   - H3: a single PUT that changed the room type AND cancelled a booking
 *     released the old room type twice and left a phantom claim on the new one.
 *   - H5/H6: double-cancel / cancel-racing-delete released the same room twice.
 *   - M1: releases were unguarded, so the above could drive the counter NEGATIVE
 *     (which is worse than wrong — `available` then exceeds `totalRooms` and the
 *     capacity guard admits more bookings than there are rooms).
 *
 * The code fixes stop NEW drift. They cannot repair drift that already happened
 * — only a recompute can. This script is that recompute.
 *
 * THE TRUTH: bookedRooms == count(Accommodation WHERE roomTypeId = X AND status != 'CANCELLED')
 * It deliberately reuses `holdsRoom()` — the SAME predicate the live code uses —
 * so the script and the runtime can never disagree about what "holds a room"
 * means. (The soldCount reconciler learned this lesson; don't re-derive the rule
 * here.)
 *
 * USAGE
 *   npx tsx scripts/reconcile-bookedrooms.ts                # dry run (default — prints, writes nothing)
 *   npx tsx scripts/reconcile-bookedrooms.ts --write        # apply the corrections
 *   npx tsx scripts/reconcile-bookedrooms.ts --event <id>   # scope to one event
 *
 * Dry-run first, ALWAYS. Read the diff before you write. These are live capacity
 * counters — a wrong correction oversells a real hotel.
 */
import { PrismaClient } from "@prisma/client";
import { holdsRoom } from "../src/lib/accommodation-rooms";

const db = new PrismaClient();

interface Drift {
  roomTypeId: string;
  roomTypeName: string;
  hotelName: string;
  eventId: string;
  eventName: string;
  totalRooms: number;
  stored: number;
  actual: number;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const eventIdx = args.indexOf("--event");
  const eventId = eventIdx !== -1 ? args[eventIdx + 1] : undefined;

  console.log(`\nReconciling RoomType.bookedRooms — ${write ? "WRITE MODE" : "dry run"}${eventId ? ` (event ${eventId})` : ""}\n`);

  const roomTypes = await db.roomType.findMany({
    where: eventId ? { hotel: { eventId } } : undefined,
    select: {
      id: true,
      name: true,
      totalRooms: true,
      bookedRooms: true,
      hotel: { select: { name: true, eventId: true, event: { select: { name: true } } } },
      accommodations: { select: { status: true } },
    },
  });

  const drifts: Drift[] = [];

  for (const rt of roomTypes) {
    // Row-truth, using the SAME predicate the live code uses.
    const actual = rt.accommodations.filter((a) => holdsRoom(a.status)).length;
    if (actual === rt.bookedRooms) continue;

    drifts.push({
      roomTypeId: rt.id,
      roomTypeName: rt.name,
      hotelName: rt.hotel.name,
      eventId: rt.hotel.eventId,
      eventName: rt.hotel.event?.name ?? "(unknown event)",
      totalRooms: rt.totalRooms,
      stored: rt.bookedRooms,
      actual,
    });
  }

  console.log(`Scanned ${roomTypes.length} room type(s). Found ${drifts.length} with drift.\n`);

  if (drifts.length === 0) {
    console.log("✅ Every counter already matches row-truth. Nothing to do.\n");
    return;
  }

  for (const d of drifts) {
    const delta = d.actual - d.stored;
    const sign = delta > 0 ? "+" : "";
    // The two ways this bites, spelled out so the operator knows what they're fixing.
    const symptom =
      d.stored > d.actual
        ? `over-counting by ${d.stored - d.actual} → ${d.stored >= d.totalRooms ? "FALSELY SOLD OUT (real bookings are being refused)" : "phantom occupancy"}`
        : `under-counting by ${d.actual - d.stored}${d.stored < 0 ? " (NEGATIVE counter — capacity guard is admitting oversells)" : " → risk of oversell"}`;

    console.log(
      `  ${d.eventName} / ${d.hotelName} / ${d.roomTypeName}\n` +
        `    stored=${d.stored}  actual=${d.actual}  (${sign}${delta})  totalRooms=${d.totalRooms}\n` +
        `    ${symptom}\n`,
    );
  }

  if (!write) {
    console.log("Dry run — nothing was written. Re-run with --write to apply.\n");
    return;
  }

  let fixed = 0;
  for (const d of drifts) {
    await db.roomType.update({
      where: { id: d.roomTypeId },
      data: { bookedRooms: d.actual },
    });
    fixed++;
  }

  console.log(`✅ Corrected ${fixed} room type counter(s) to match row-truth.\n`);
}

main()
  .catch((err) => {
    console.error("Reconciliation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
