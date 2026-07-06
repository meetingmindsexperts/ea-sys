/**
 * Backfill / full reconcile — push EVERY EA-SYS contact into the external
 * `contacts_centralv1` table via the target's `ea_upsert_contacts` RPC
 * (arrays UNION, scalars ENRICH, never touches evenstair/created_at/fetched_at/
 * mailchimp_*). Idempotent + safe to re-run.
 *
 *   npx tsx scripts/backfill-contacts-central.ts           # dry-run (counts + sample)
 *   npx tsx scripts/backfill-contacts-central.ts --write   # actually push
 *
 * Prereqs: the ea_upsert_contacts + ea_array_union functions exist in the target
 * project (see docs/CONTACTS_CENTRAL_SYNC.md), and CONTACTS_CENTRAL_ENABLED=true
 * + CONTACTS_CENTRAL_URL + CONTACTS_CENTRAL_SERVICE_KEY are set in .env.
 */
import "dotenv/config";
import {
  buildCentralRows,
  upsertCentralRows,
  isCentralSyncConfigured,
} from "../src/lib/contacts-central-sync";
import { db } from "../src/lib/db";

async function main() {
  const write = process.argv.includes("--write");

  if (!isCentralSyncConfigured()) {
    console.error(
      "❌ Not configured — need CONTACTS_CENTRAL_ENABLED=true, CONTACTS_CENTRAL_URL, CONTACTS_CENTRAL_SERVICE_KEY in .env.",
    );
    process.exit(1);
  }

  console.log("Building rows from ALL EA-SYS contacts…");
  const rows = await buildCentralRows({}); // no `since` → full reconcile
  console.log(`Prepared ${rows.length} contact rows.`);

  if (!write) {
    console.log("\nDRY RUN — nothing sent. Re-run with --write to push.");
    console.log("Sample (first 2):");
    console.log(JSON.stringify(rows.slice(0, 2), null, 2));
    await db.$disconnect();
    return;
  }

  console.log(`Pushing ${rows.length} rows to contacts_centralv1 …`);
  const { sent, failed } = await upsertCentralRows(rows);
  console.log(`\n✅ Done. sent=${sent} failed=${failed}`);
  await db.$disconnect();
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
