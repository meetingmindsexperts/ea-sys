/**
 * One-time correction: registrations a promo code already pays for in full,
 * still marked UNPAID / PENDING, are set to COMPLIMENTARY (or INCLUSIVE under
 * the sponsor, when the sponsor's code "covers the fee").
 *
 * Why they exist: until Nov 16, 2026 a code entered AFTER registering left the
 * payment status untouched, while the same code on the form made the
 * registration Complimentary. The service now settles both the same way
 * (`paymentStatusForFee`); this brings the existing rows into line. The
 * decision per row is `promoSettlement` in src/lib/promo-settlement.ts.
 *
 * What it touches: `Registration.paymentStatus` (and `sponsorId` for a
 * sponsor-covered code), one AuditLog row per registration. Nothing else: no
 * email is sent, no invoice is made, no seat or code counter moves.
 * Left alone, and counted in the summary: cancelled registrations, group
 * members, a registration that already holds a payment, one with a checkout
 * open (PENDING, or a stored Stripe session), and anything that still owes.
 *
 * Idempotent: a settled row is no longer outstanding, so a second run finds
 * nothing. Each write is guarded on the status, the code, the discount, the
 * type and the rate the row was read with, so a row that changed in between is
 * skipped, not overwritten. The events' cached counts are refreshed at the end.
 *
 * Dry run by default. Run AFTER deploying the service change.
 *
 * Usage (on the box, through the worker container):
 *   docker exec ea-sys-worker npx tsx scripts/settle-promo-covered-registrations.ts
 *   docker exec ea-sys-worker npx tsx scripts/settle-promo-covered-registrations.ts --event <eventId>
 *   docker exec ea-sys-worker npx tsx scripts/settle-promo-covered-registrations.ts --write
 */
import { db } from "../src/lib/db";
import { promoSettlement } from "../src/lib/promo-settlement";
import { refreshEventStatsNow } from "../src/lib/event-stats";

const SOURCE = "settle-promo-covered-registrations";
const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;
// "--event" with its id forgotten must not quietly mean "every event".
const eventFilterMissing = eventArgIdx >= 0 && (!eventFilter || eventFilter.startsWith("--"));

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname || "unknown";
  } catch {
    return "unparseable DATABASE_URL";
  }
}

async function main() {
  if (eventFilterMissing) {
    console.error("--event needs an event id after it. Nothing was read or changed.");
    process.exitCode = 1;
    return;
  }
  console.log(`Database host: ${databaseHost()}`);
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");

  const regs = await db.registration.findMany({
    where: {
      ...(eventFilter ? { eventId: eventFilter } : {}),
      paymentStatus: { in: ["UNPAID", "PENDING", "UNASSIGNED"] },
      status: { not: "CANCELLED" },
      promoCodeId: { not: null },
    },
    select: {
      id: true,
      serialId: true,
      eventId: true,
      status: true,
      paymentStatus: true,
      groupId: true,
      originalPrice: true,
      discountAmount: true,
      sponsorId: true,
      promoCodeId: true,
      ticketTypeId: true,
      pricingTierId: true,
      stripeCheckoutSessionId: true,
      payments: { where: { status: "PAID" }, select: { amount: true } },
      pricingTier: { select: { price: true } },
      ticketType: { select: { price: true, name: true } },
      promoCode: { select: { code: true, sponsorCoversFee: true, sponsorId: true } },
      event: { select: { name: true } },
    },
    orderBy: [{ eventId: "asc" }, { serialId: "asc" }],
  });

  console.log(`Outstanding registrations carrying a promo code: ${regs.length}${eventFilter ? ` (event ${eventFilter})` : ""}\n`);

  let settled = 0;
  let skipped = 0;
  let failed = 0;
  const leftAlone = new Map<string, number>();
  const changedEvents = new Set<string>();

  for (const reg of regs) {
    const paidTotal = reg.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const decision = promoSettlement({ ...reg, paidTotal });
    if (!decision.settle) {
      leftAlone.set(decision.why, (leftAlone.get(decision.why) ?? 0) + 1);
      continue;
    }
    const serial = reg.serialId != null ? String(reg.serialId).padStart(3, "0") : "no number";
    console.log(
      `  ${reg.event.name} | #${serial} | ${reg.ticketType?.name ?? "no type"} | code ${reg.promoCode?.code} | ` +
        `${reg.paymentStatus} -> ${decision.to} | reg ${reg.id}`,
    );
    if (!write) {
      settled++;
      continue;
    }
    try {
      const changed = await db.$transaction(async (tx) => {
        // Guarded on everything the decision read: a row whose status, code,
        // discount, type or rate changed meanwhile is left as it is.
        const updated = await tx.registration.updateMany({
          where: {
            id: reg.id,
            paymentStatus: reg.paymentStatus,
            status: reg.status,
            promoCodeId: reg.promoCodeId,
            discountAmount: reg.discountAmount,
            originalPrice: reg.originalPrice,
            ticketTypeId: reg.ticketTypeId,
            pricingTierId: reg.pricingTierId,
            groupId: null,
            stripeCheckoutSessionId: null,
          },
          data: {
            paymentStatus: decision.to,
            ...(decision.sponsorId ? { sponsorId: decision.sponsorId } : {}),
          },
        });
        if (updated.count === 0) return false;
        await tx.auditLog.create({
          data: {
            eventId: reg.eventId,
            userId: null,
            action: "UPDATE",
            entityType: "Registration",
            entityId: reg.id,
            changes: {
              source: SOURCE,
              reason: "A promo code covers the whole fee: the payment status follows the balance.",
              code: reg.promoCode?.code ?? null,
              before: { paymentStatus: reg.paymentStatus, ...(decision.sponsorId ? { sponsorId: reg.sponsorId } : {}) },
              after: { paymentStatus: decision.to, ...(decision.sponsorId ? { sponsorId: decision.sponsorId } : {}) },
            },
          },
        });
        return true;
      });
      if (changed) {
        settled++;
        changedEvents.add(reg.eventId);
      } else {
        skipped++;
        console.log(`    skipped reg ${reg.id}: it changed since it was read`);
      }
    } catch (err) {
      failed++;
      console.error(`    FAILED reg ${reg.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n${write ? "Settled" : "Would settle"}: ${settled}`);
  if (skipped > 0) console.log(`Skipped (changed meanwhile): ${skipped}`);
  if (failed > 0) console.log(`Failed: ${failed}`);
  for (const [why, count] of leftAlone) console.log(`Left alone (${why}): ${count}`);
  // The events' cached counts by payment status moved. Awaited: a
  // fire-and-forget refresh would race the disconnect below.
  for (const eventId of changedEvents) {
    try {
      await refreshEventStatsNow(eventId);
    } catch (err) {
      console.error(`  Counts not refreshed for event ${eventId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (!write && settled > 0) console.log("\nNothing was changed. Re-run with --write to apply.");
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
