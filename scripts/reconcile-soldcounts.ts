/**
 * One-time reconciliation — recompute TicketType.soldCount AND
 * PricingTier.soldCount from row-truth and reset any that have drifted.
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
 * (`holdsSeat`), and that seat is tallied on EITHER the tier (public register +
 * pricingTierId) OR the ticket type (`seatCounter`). We re-derive both counters
 * from the live rows using those exact helpers — so the script can never drift
 * from the runtime routing — and write the corrected values.
 *
 * Idempotent + safe to re-run. Run ONCE after deploying the P1.1 code fix.
 *
 * Usage:
 *   npx tsx scripts/reconcile-soldcounts.ts                    # dry run (all events)
 *   npx tsx scripts/reconcile-soldcounts.ts --write            # apply (all events)
 *   npx tsx scripts/reconcile-soldcounts.ts --event <eventId>  # scope to one event
 *   npx tsx scripts/reconcile-soldcounts.ts --write --event <eventId>
 */
import { db } from "../src/lib/db";
import { holdsSeat, seatCounter } from "../src/lib/registration-seat";

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
    // Re-derive both counters from row-truth via the SAME helpers the runtime
    // uses, so reconciliation and routing can't disagree.
    const regs = await db.registration.findMany({
      where: { eventId: event.id, status: { not: "CANCELLED" } },
      select: {
        status: true,
        attendanceMode: true,
        ticketTypeId: true,
        pricingTierId: true,
        createdSource: true,
      },
    });

    const tierComputed = new Map<string, number>();
    const typeComputed = new Map<string, number>();
    for (const r of regs) {
      if (!holdsSeat(r.status, r.attendanceMode)) continue;
      const c = seatCounter(r);
      if (!c) continue;
      const m = c.kind === "tier" ? tierComputed : typeComputed;
      m.set(c.id, (m.get(c.id) ?? 0) + 1);
    }

    const ticketTypes = await db.ticketType.findMany({
      where: { eventId: event.id },
      select: {
        id: true,
        name: true,
        soldCount: true,
        pricingTiers: { select: { id: true, name: true, soldCount: true } },
      },
    });

    const drifts: string[] = [];

    for (const tt of ticketTypes) {
      countersChecked++;
      const computed = typeComputed.get(tt.id) ?? 0;
      if (computed !== tt.soldCount) {
        countersDrifted++;
        drifts.push(`  TicketType "${tt.name}" (${tt.id}): stored ${tt.soldCount} → ${computed}`);
        if (write) {
          await db.ticketType.update({ where: { id: tt.id }, data: { soldCount: computed } });
          countersFixed++;
        }
      }
      for (const tier of tt.pricingTiers) {
        countersChecked++;
        const tierC = tierComputed.get(tier.id) ?? 0;
        if (tierC !== tier.soldCount) {
          countersDrifted++;
          drifts.push(`  PricingTier "${tt.name} / ${tier.name}" (${tier.id}): stored ${tier.soldCount} → ${tierC}`);
          if (write) {
            await db.pricingTier.update({ where: { id: tier.id }, data: { soldCount: tierC } });
            countersFixed++;
          }
        }
      }
    }

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
