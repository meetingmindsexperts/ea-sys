/**
 * One-time reconciliation — recompute TicketType.soldCount AND
 * PricingTier.soldCount AND Event.seatCount (since Oct 29, 2026) from
 * row-truth and reset any that have drifted.
 *
 * WHY: before the ROADMAP P1.1 fix, the decrement/transition paths (cancel /
 * delete / type-change / bulk / MCP) unconditionally moved `TicketType.soldCount`
 * even for public+tier registrations whose seat actually lived on the
 * `PricingTier.soldCount` counter. So a public+tier cancellation leaked BOTH
 * ways — the tier counter leaked up (phantom sell-out) and the ticket-type
 * counter leaked down (could go negative → oversell). The code fix stops NEW
 * drift; this script repairs counters that already drifted from past activity.
 *
 * HOW: a registration holds a seat iff it is non-cancelled AND in-person
 * (`holdsSeat`). Its PRIMARY counter is the tier (public register +
 * pricingTierId) or the ticket type (`seatCounter`); since Sep 8, 2026 a
 * tier-held seat is ALSO counted on the ticket type, whose limit is the hard
 * ceiling over all of its tiers (registration-seat.ts). So: tier counter =
 * that tier's public sales; type counter = every seat under the type. We
 * re-derive both from the live rows using those exact helpers — so the script
 * can never drift from the runtime routing — and write the corrected values.
 *
 * Idempotent + safe to re-run. Run after the P1.1 code fix, and again whenever
 * a counter is suspected of drift (a deploy window, a crashed transaction).
 *
 * Usage:
 *   npx tsx scripts/reconcile-soldcounts.ts                    # dry run (all events)
 *   npx tsx scripts/reconcile-soldcounts.ts --write            # apply (all events)
 *   npx tsx scripts/reconcile-soldcounts.ts --event <eventId>  # scope to one event
 *   npx tsx scripts/reconcile-soldcounts.ts --write --event <eventId>
 */
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { holdsEventSeat, holdsSeat, seatCounter } from "../src/lib/registration-seat";

const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;
// --exclude <id,id,...> : skip these events entirely (e.g. ones whose legacy
// tier rows need a separate decision before reconciling).
const excludeArgIdx = process.argv.indexOf("--exclude");
const excludeIds = new Set(
  excludeArgIdx >= 0 && process.argv[excludeArgIdx + 1]
    ? process.argv[excludeArgIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : [],
);

type Client = Prisma.TransactionClient | typeof db;
type Write = (tx: Prisma.TransactionClient) => Promise<unknown>;

/**
 * Every counter for one event from row truth, with the same helpers the
 * runtime routes by, so reconciliation and routing cannot disagree: the type
 * and tier soldCounts and the event's seatCount (held iff a ticket seat is,
 * holdsEventSeat; a row with no type holds none). Returns the drifts found and
 * the writes that fix them.
 */
async function planEvent(client: Client, eventId: string): Promise<{ checked: number; drifts: string[]; writes: Write[] }> {
  const [regs, ticketTypes, event] = await Promise.all([
    client.registration.findMany({
      where: { eventId, status: { not: "CANCELLED" } },
      select: { status: true, attendanceMode: true, ticketTypeId: true, pricingTierId: true, createdSource: true },
    }),
    client.ticketType.findMany({
      where: { eventId },
      select: { id: true, name: true, soldCount: true, pricingTiers: { select: { id: true, name: true, soldCount: true } } },
    }),
    client.event.findUniqueOrThrow({ where: { id: eventId }, select: { seatCount: true } }),
  ]);

  const tierComputed = new Map<string, number>();
  const typeComputed = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const r of regs) {
    if (!holdsSeat(r.status, r.attendanceMode)) continue;
    const c = seatCounter(r);
    if (!c) continue;
    if (c.kind === "tier") {
      bump(tierComputed, c.id);
      // Since Sep 8, 2026 the ticket type is the ceiling over its tiers, so
      // it counts this seat too (the appliers move both counters).
      if (r.ticketTypeId) bump(typeComputed, r.ticketTypeId);
    } else {
      bump(typeComputed, c.id);
    }
  }

  let checked = 0;
  const drifts: string[] = [];
  const writes: Write[] = [];
  for (const tt of ticketTypes) {
    checked++;
    const computed = typeComputed.get(tt.id) ?? 0;
    if (computed !== tt.soldCount) {
      drifts.push(`  TicketType "${tt.name}" (${tt.id}): stored ${tt.soldCount} → ${computed}`);
      writes.push((tx) => tx.ticketType.update({ where: { id: tt.id }, data: { soldCount: computed } }));
    }
    for (const tier of tt.pricingTiers) {
      checked++;
      const tierC = tierComputed.get(tier.id) ?? 0;
      if (tierC !== tier.soldCount) {
        drifts.push(`  PricingTier "${tt.name} / ${tier.name}" (${tier.id}): stored ${tier.soldCount} → ${tierC}`);
        writes.push((tx) => tx.pricingTier.update({ where: { id: tier.id }, data: { soldCount: tierC } }));
      }
    }
  }
  // The event-wide counter (Oct 29, 2026): imports used to count rows with no
  // type, and the completion form counted them again on getting a type.
  checked++;
  const eventComputed = regs.filter((r) => holdsEventSeat(r)).length;
  if (eventComputed !== event.seatCount) {
    drifts.push(`  Event seats: stored ${event.seatCount} → ${eventComputed}`);
    writes.push((tx) => tx.event.update({ where: { id: eventId }, data: { seatCount: eventComputed } }));
  }
  return { checked, drifts, writes };
}

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");

  const events = await db.event.findMany({
    where: eventFilter ? { id: eventFilter } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let countersChecked = 0;
  let countersDrifted = 0;
  let countersFixed = 0;
  let excludedCount = 0;

  for (const event of events) {
    if (excludeIds.has(event.id)) {
      excludedCount++;
      console.log(`Event "${event.name}" (${event.id}): SKIPPED (--exclude)\n`);
      continue;
    }
    // In --write mode each event is one transaction (review of a10e8058, M3):
    // its type rows, then its tier rows, then the event row are locked (the
    // order the claim paths take them), the registrations are read UNDER those
    // locks, and only then are the counters computed and written. A plain
    // read-then-write would drop a registration that committed in between.
    const result = write
      ? await db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "TicketType" WHERE "eventId" = ${event.id} ORDER BY id FOR UPDATE`;
            await tx.$queryRaw`SELECT pt.id FROM "PricingTier" pt JOIN "TicketType" tt ON tt.id = pt."ticketTypeId" WHERE tt."eventId" = ${event.id} ORDER BY pt.id FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${event.id} FOR UPDATE`;
            const plan = await planEvent(tx, event.id);
            for (const w of plan.writes) await w(tx);
            return plan;
          },
          { timeout: 60_000 },
        )
      : await planEvent(db, event.id);
    countersChecked += result.checked;
    countersDrifted += result.drifts.length;
    if (write) countersFixed += result.writes.length;
    const drifts = result.drifts;

    if (drifts.length > 0) {
      console.log(`Event "${event.name}" (${event.id}):`);
      console.log(drifts.join("\n"));
      console.log("");
    }
  }

  console.log("─".repeat(60));
  console.log(`Events scanned:    ${events.length}${excludedCount ? ` (${excludedCount} skipped via --exclude)` : ""}`);
  console.log(`Counters checked:  ${countersChecked}`);
  console.log(`Counters drifted:  ${countersDrifted}`);
  console.log(write ? `Counters fixed:    ${countersFixed}` : `(dry run — re-run with --write to fix ${countersDrifted})`);
}

main()
  .catch((err) => {
    console.error("reconcile-soldcounts failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
