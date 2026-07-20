/**
 * Verification harness for the cancel → credit-owed financials, against the
 * LOCAL test DB (ea_sys_test) using the REAL seeded rows, the REAL
 * payment-service.cancelRegistration, and the REAL compute helpers — i.e. the
 * code path the detail route runs, not synthetic unit inputs. This is the
 * layer the unit tests couldn't reach (they passed hand-built paidTotal
 * values; here paidTotal comes from actual Payment rows / the route's
 * fallback), which is exactly where the "−$157.50 on a Pending reg"
 * regression lived.
 *
 *   DATABASE_URL=postgresql://krishnapallapolu@localhost:5432/ea_sys_test \
 *   DIRECT_URL=$DATABASE_URL npx tsx prisma/verify-cancel-financials.ts
 *
 * Re-run prisma/seed-local-cancel-scenarios.ts first (idempotent) to reset.
 */
import "./local-db-guard"; // MUST be first — forces + guards the local test DB
import { PrismaClient } from "@prisma/client";
import {
  computeRegistrationFinancials,
  computeCancelledCreditState,
  readRegistrationBasePrice,
} from "../src/lib/registration-financials";
import { cancelRegistration } from "../src/services/payment-service";
import { EVENT_ID } from "../e2e/fixtures/seed-constants";

const db = new PrismaClient();
const ORG_ID = "e2e-org";
const REG_PENDING_ID = "local-reg-pending";
const REG_PAID_ID = "local-reg-paid";

let failures = 0;
function check(label: string, cond: boolean, detail: string) {
  const mark = cond ? "✓" : "✗";
  if (!cond) failures++;
  console.log(`  ${mark} ${label} — ${detail}`);
}

/**
 * Mirror the detail route's financials assembly (route.ts) EXACTLY, reading
 * real DB rows, so this reflects what the UI renders.
 */
async function financialsFor(registrationId: string) {
  const [registration, event, creditedAgg] = await Promise.all([
    db.registration.findUnique({
      where: { id: registrationId },
      include: { ticketType: true, pricingTier: true, payments: true },
    }),
    db.event.findUnique({ where: { id: EVENT_ID }, select: { taxRate: true, taxLabel: true } }),
    db.invoice.aggregate({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      _sum: { total: true },
    }),
  ]);
  if (!registration || !event) throw new Error(`missing rows for ${registrationId}`);

  const subtotal = readRegistrationBasePrice(registration);
  const currency = registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
  const totalPaid = (registration.payments ?? [])
    .filter((p) => p.status?.toLowerCase() === "succeeded" || p.status === "PAID")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const baseFinancials = computeRegistrationFinancials({
    subtotal,
    discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
    taxRate: event.taxRate ? Number(event.taxRate) : null,
    taxLabel: event.taxLabel,
    currency,
    totalPaid,
  });
  const paidTotal = totalPaid > 0 ? totalPaid : baseFinancials.total;
  const cancelledCredit = computeCancelledCreditState({
    isCancelled: registration.status === "CANCELLED",
    paymentStatus: registration.paymentStatus,
    paidTotal,
    refundedAmount: Number(registration.refundedAmount ?? 0),
    creditedAmount: Number(creditedAgg._sum.total ?? 0),
  });
  return { registration, baseFinancials, paidTotal, cancelledCredit };
}

async function main() {
  console.log("[verify] cancel → credit-owed financials (real service + real DB rows)\n");

  // ── Scenario 1: PENDING reg (the regression). Cancel via "Just cancel"
  //    (refund:false) — the exact button the organizer clicked. ────────────
  console.log("Scenario 1 — cancel an UNPAID/PENDING registration (attendee owed money):");
  let f = await financialsFor(REG_PENDING_ID);
  check("pre: total is 157.50", Math.abs(f.baseFinancials.total - 157.5) < 0.01, `total=${f.baseFinancials.total}`);
  check("pre: paidTotal FALLS BACK to total (no Payment rows)", Math.abs(f.paidTotal - 157.5) < 0.01, `paidTotal=${f.paidTotal} (this is the trap)`);

  const res1 = await cancelRegistration({
    registrationId: REG_PENDING_ID,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    refund: false,
    source: "rest",
    issuedByUserId: null,
  });
  check("cancel succeeds", res1.ok, res1.ok ? "ok" : `code=${(res1 as { code?: string }).code}`);

  f = await financialsFor(REG_PENDING_ID);
  check("status is CANCELLED", f.registration.status === "CANCELLED", f.registration.status);
  check("BUG-FIXED: retained is 0 (was 157.50)", f.cancelledCredit.retained === 0, `retained=${f.cancelledCredit.retained}`);
  check("BUG-FIXED: no credit-note prompt", f.cancelledCredit.needsCreditNote === false, `needsCreditNote=${f.cancelledCredit.needsCreditNote}`);
  check("no negative balance shown → Amount Due 0", f.cancelledCredit.retained === 0, "UI renders Amount Due 0, not −157.50");

  // ── Scenario 2: PAID reg. Cancel via "Just cancel" (refund:false). The
  //    negative "credit owed" + prompt is the CORRECT behaviour here. ──────
  console.log("\nScenario 2 — cancel a PAID registration, keep the payment (Just cancel):");
  f = await financialsFor(REG_PAID_ID);
  check("pre: paidTotal is real 157.50 from Payment row", Math.abs(f.paidTotal - 157.5) < 0.01, `paidTotal=${f.paidTotal}`);

  const res2 = await cancelRegistration({
    registrationId: REG_PAID_ID,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    refund: false,
    source: "rest",
    issuedByUserId: null,
  });
  check("cancel succeeds", res2.ok, res2.ok ? "ok" : `code=${(res2 as { code?: string }).code}`);

  f = await financialsFor(REG_PAID_ID);
  check("status is CANCELLED", f.registration.status === "CANCELLED", f.registration.status);
  check("still PAID (payment kept)", f.registration.paymentStatus === "PAID", f.registration.paymentStatus);
  check("CORRECT: retained 157.50 (credit owed to attendee)", Math.abs(f.cancelledCredit.retained - 157.5) < 0.01, `retained=${f.cancelledCredit.retained}`);
  check("CORRECT: prompts for a credit note (none issued yet)", f.cancelledCredit.needsCreditNote === true, `needsCreditNote=${f.cancelledCredit.needsCreditNote}`);

  console.log(`\n[verify] ${failures === 0 ? "ALL CHECKS PASSED ✓" : `${failures} CHECK(S) FAILED ✗`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
