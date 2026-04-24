/**
 * One-time backfill — populate the new `cardBrand`, `cardLast4`,
 * `paymentMethodType`, `paidAt` columns on historical `Payment` rows
 * by re-fetching the PaymentIntent + latest Charge from Stripe.
 *
 * The Apr 24 migration added these columns as nullable so existing
 * rows remained valid, but their Invoice PDFs render without the
 * "Payment Received" card block and the Billing tab in the
 * registration detail sheet doesn't show "via Visa ending 4242". This
 * script closes that gap.
 *
 * Behavior:
 *   - Only touches rows where `stripePaymentId IS NOT NULL` and at
 *     least one of the four target columns is still NULL.
 *   - Safe to re-run — idempotent per-row, skips already-populated rows.
 *   - Rate-limited at 10 req/s to stay well under Stripe's 100 req/s
 *     account-level cap even with the 2 API calls per row (retrieve
 *     PaymentIntent + retrieve Charge).
 *   - Logs per-row outcome so failures are visible without aborting
 *     the whole batch.
 *
 * Usage:
 *   npx tsx scripts/backfill-payment-card-details.ts          # dry run
 *   npx tsx scripts/backfill-payment-card-details.ts --write  # apply
 */

import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const write = process.argv.includes("--write");
const db = new PrismaClient();

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required");
  return new Stripe(key);
}

// Respect Stripe rate limits: we issue up to 2 calls per row, so cap
// at 10 rows/sec = 20 calls/sec (well under the 100/s live-mode limit).
async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function main() {
  const stripe = getStripe();

  const targets = await db.payment.findMany({
    where: {
      stripePaymentId: { not: null },
      OR: [
        { cardBrand: null },
        { cardLast4: null },
        { paymentMethodType: null },
        { paidAt: null },
      ],
    },
    select: {
      id: true,
      registrationId: true,
      stripePaymentId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${targets.length} Payment rows needing backfill.`);
  if (targets.length === 0) return;
  if (!write) {
    console.log("Dry run — no changes will be written. Re-run with --write to apply.");
    console.log("First 5 candidates:");
    for (const t of targets.slice(0, 5)) {
      console.log(`  ${t.id}  ${t.stripePaymentId}  ${t.createdAt.toISOString()}`);
    }
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of targets) {
    try {
      const pi = await stripe.paymentIntents.retrieve(row.stripePaymentId!);
      const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
      if (!chargeId) {
        console.warn(`SKIP ${row.id} — no latest_charge on PaymentIntent ${row.stripePaymentId}`);
        skipped++;
        continue;
      }

      const charge = await stripe.charges.retrieve(chargeId);
      const pmd = charge.payment_method_details;
      const data: {
        cardBrand?: string | null;
        cardLast4?: string | null;
        paymentMethodType?: string | null;
        paidAt?: Date;
      } = {};

      if (pmd) {
        data.paymentMethodType = pmd.type || null;
        if (pmd.card) {
          data.cardBrand = pmd.card.brand || null;
          data.cardLast4 = pmd.card.last4 || null;
        }
      }
      if (charge.created) {
        data.paidAt = new Date(charge.created * 1000);
      }

      if (Object.keys(data).length === 0) {
        console.warn(`SKIP ${row.id} — Stripe returned no usable details`);
        skipped++;
        continue;
      }

      await db.payment.update({
        where: { id: row.id },
        data,
      });
      updated++;
      console.log(
        `OK   ${row.id}  ${data.cardBrand ?? "-"} ${data.cardLast4 ?? "----"}  ${data.paidAt?.toISOString() ?? "-"}`
      );
    } catch (err) {
      failed++;
      console.error(`FAIL ${row.id} — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Back off to respect Stripe rate limits (2 calls/row × 10 rows/s = 20 calls/s)
    await sleep(100);
  }

  console.log(`\nDone. updated=${updated}  skipped=${skipped}  failed=${failed}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
