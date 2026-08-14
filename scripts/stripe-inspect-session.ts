/**
 * Read-only lookup of a Stripe Checkout Session by id.
 *
 * WHY THIS EXISTS. `Stripe checkout session missing registrationId metadata`
 * fires when a `checkout.session.completed` arrives carrying neither
 * `registrationId` nor `groupId` — i.e. a session THIS APP did not create. The
 * warning logs only the session id, and the Stripe Dashboard's search bar does
 * NOT index Checkout Session ids (it searches customers, payments, invoices,
 * subscriptions), so pasting the id there returns "no results found" whether or
 * not the session exists. That dead end is what this script removes.
 *
 * Usage (on the box, via the worker container — same runtime, same env, same
 * Stripe key the webhook itself uses):
 *
 *   docker exec ea-sys-worker npx tsx scripts/stripe-inspect-session.ts cs_live_xxx
 *
 * READ-ONLY. It calls `checkout.sessions.retrieve` and prints a summary. It
 * performs no writes, and it never prints the API key or full customer objects.
 */

import { getStripe } from "@/lib/stripe";

async function main() {
  const sessionId = process.argv[2];
  if (!sessionId || !sessionId.startsWith("cs_")) {
    console.error("Usage: stripe-inspect-session.ts <cs_live_... | cs_test_...>");
    process.exit(1);
  }

  const stripe = await getStripe();
  const s = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent", "line_items"],
  });

  const money = (v: number | null | undefined, cur: string | null | undefined) =>
    v == null ? "—" : `${(v / 100).toFixed(2)} ${(cur ?? "").toUpperCase()}`;

  console.log("\n── Checkout session ─────────────────────────────────────────");
  console.log("id             ", s.id);
  console.log("created        ", new Date(s.created * 1000).toISOString());
  console.log("mode           ", s.mode);          // payment | setup | subscription
  console.log("status         ", s.status);        // complete | open | expired
  console.log("payment_status ", s.payment_status); // paid | unpaid | no_payment_required
  console.log("amount_total   ", money(s.amount_total, s.currency));
  console.log("customer_email ", s.customer_details?.email ?? s.customer_email ?? "—");
  console.log("client_ref_id  ", s.client_reference_id ?? "—");

  // The whole point: what (if anything) identified this session to us.
  const meta = s.metadata ?? {};
  console.log("\n── Metadata (empty ⇒ not created by EA-SYS) ─────────────────");
  console.log(Object.keys(meta).length ? meta : "(none)");

  // Where it came from. A Payment Link or an invoice is the benign explanation;
  // both show up here and neither is searchable by session id in the Dashboard.
  console.log("\n── Origin ──────────────────────────────────────────────────");
  console.log("payment_link   ", s.payment_link ?? "— (not a Payment Link)");
  console.log("invoice        ", s.invoice ?? "—");
  console.log("subscription   ", s.subscription ?? "—");

  const pi = s.payment_intent;
  if (pi && typeof pi !== "string") {
    console.log("\n── PaymentIntent (searchable in the Dashboard) ─────────────");
    console.log("id             ", pi.id);
    console.log("status         ", pi.status);
    console.log("amount         ", money(pi.amount, pi.currency));
    console.log("description    ", pi.description ?? "—");
    console.log("\n→ Paste THIS id into the Dashboard search; PaymentIntents are indexed.");
  } else {
    console.log("\n(no PaymentIntent — a $0 / setup-mode session creates none,");
    console.log(" which is also why nothing appears under Payments)");
  }

  const items = s.line_items?.data ?? [];
  if (items.length) {
    console.log("\n── Line items ──────────────────────────────────────────────");
    for (const li of items) {
      console.log(`  ${li.quantity} x ${li.description ?? "(no description)"} — ${money(li.amount_total, s.currency)}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Lookup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
