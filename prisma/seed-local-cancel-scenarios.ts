/**
 * Local-only scenario seed for manually driving the cancel → credit-note /
 * refund financial flows against the LOCAL test DB (ea_sys_test), the same
 * way the Playwright e2e suite works. NOT run in CI — this is a dev aid so
 * money-mutating flows can be exercised without touching prod.
 *
 * Run AFTER `npx tsx prisma/seed-e2e.ts` (needs the e2e org/event/tickets):
 *   DATABASE_URL=postgresql://krishnapallapolu@localhost:5432/ea_sys_test \
 *   DIRECT_URL=$DATABASE_URL npx tsx prisma/seed-local-cancel-scenarios.ts
 *
 * Idempotent: deletes its own fixed-id rows first.
 */
import "./local-db-guard"; // MUST be first — forces + guards the local test DB
import { PrismaClient } from "@prisma/client";
import { seedCore } from "./seed-e2e-core";
import { EVENT_ID, PAID_TICKET_TYPE_ID } from "../e2e/fixtures/seed-constants";

const db = new PrismaClient();

const TIER_ID = "local-tier-earlybird";
const REG_PENDING_ID = "local-reg-pending"; // the bug case: attendee owes money
const REG_PAID_ID = "local-reg-paid"; // credit-owed case after cancel
const ATT_PENDING_ID = "local-att-pending";
const ATT_PAID_ID = "local-att-paid";
const PAYMENT_ID = "local-payment-paid";

async function main() {
  console.log("[seed-local] cancel/credit-note scenarios → ea_sys_test");

  // Ensure the base e2e fixtures (org / event / ticket types / users) exist —
  // idempotent, so this file is fully standalone and stays behind the guard
  // (no dependency on the shell-env test:e2e:seed, which would fall back to
  // prod if DATABASE_URL_TEST wasn't exported).
  await seedCore(db);

  // Give the event a real VAT rate so the totals block matches the screenshot.
  await db.event.update({
    where: { id: EVENT_ID },
    data: { taxRate: 5, taxLabel: "VAT" },
  });

  // Early Bird tier (USD 150) on the Standard ticket type.
  await db.pricingTier.deleteMany({ where: { id: TIER_ID } });
  await db.pricingTier.create({
    data: {
      id: TIER_ID,
      ticketTypeId: PAID_TICKET_TYPE_ID,
      name: "Early Bird",
      price: 150,
      currency: "USD",
      isActive: true,
    },
  });

  // Clean prior runs (payment → registration → attendee order for FKs).
  await db.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await db.registration.deleteMany({ where: { id: { in: [REG_PENDING_ID, REG_PAID_ID] } } });
  await db.attendee.deleteMany({ where: { id: { in: [ATT_PENDING_ID, ATT_PAID_ID] } } });

  // (1) PENDING registration — attendee owes USD 157.50, nothing collected.
  //     Cancelling this must show Amount Due 0, NOT a negative "credit owed".
  await db.attendee.create({
    data: {
      id: ATT_PENDING_ID,
      firstName: "Priya",
      lastName: "Pending",
      email: "priya.pending@test.local",
      registrationType: "Standard",
    },
  });
  await db.registration.create({
    data: {
      id: REG_PENDING_ID,
      eventId: EVENT_ID,
      attendeeId: ATT_PENDING_ID,
      ticketTypeId: PAID_TICKET_TYPE_ID,
      pricingTierId: TIER_ID,
      originalPrice: 150,
      status: "CONFIRMED",
      paymentStatus: "PENDING",
      qrCode: "LOCAL-PENDING-QR",
      badgeType: "Delegate",
      createdSource: "ADMIN_DASHBOARD",
    },
  });

  // (2) PAID registration — USD 157.50 collected. Cancelling → negative
  //     "credit owed" + "needs credit note" is the CORRECT behaviour.
  await db.attendee.create({
    data: {
      id: ATT_PAID_ID,
      firstName: "Paul",
      lastName: "Paid",
      email: "paul.paid@test.local",
      registrationType: "Standard",
    },
  });
  await db.registration.create({
    data: {
      id: REG_PAID_ID,
      eventId: EVENT_ID,
      attendeeId: ATT_PAID_ID,
      ticketTypeId: PAID_TICKET_TYPE_ID,
      pricingTierId: TIER_ID,
      originalPrice: 150,
      status: "CONFIRMED",
      paymentStatus: "PAID",
      qrCode: "LOCAL-PAID-QR",
      badgeType: "Delegate",
      createdSource: "ADMIN_DASHBOARD",
    },
  });
  await db.payment.create({
    data: {
      id: PAYMENT_ID,
      registrationId: REG_PAID_ID,
      amount: 157.5,
      currency: "USD",
      status: "PAID",
      paymentMethodType: "card",
      cardBrand: "Visa",
      cardLast4: "4242",
      paidAt: new Date(),
    },
  });

  console.log("[seed-local] done");
  console.log(`  PENDING reg (bug case, expect Amount Due 0 on cancel): ${REG_PENDING_ID}`);
  console.log(`  PAID reg    (expect −157.50 credit owed on cancel):    ${REG_PAID_ID}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
