/**
 * One-off: seed the CRM Companies list from the contact store's free-text
 * `Contact.organization` values.
 *
 * WHY: the CRM's account table (`CrmCompany`) starts empty — until it is seeded,
 * the Companies tab is an empty room and every deal's account has to be typed
 * from scratch. The org already KNOWS its companies: they are the distinct
 * `organization` strings on the event contact store. This mints one CrmCompany
 * per distinct normalized name (docs/CRM_STATUS.html §6 "Backfill").
 *
 * WHAT IT DOES NOT DO:
 *   - It does NOT create CrmContacts. Event contacts are HCPs — a deliberately
 *     DIFFERENT population from business contacts (see src/crm/README.md §3.2).
 *   - It does NOT link Contact rows to companies. The event Contact model has no
 *     CRM columns (the July 14 CrmContact rework left it alone, on purpose).
 *   - It does NOT set `needsReview`. The fuzzy near-duplicate flag exists to
 *     catch a human typing a variant of an existing account; bulk-seeding
 *     hundreds of institution names through it would flood the review worklist
 *     with noise. Post-seed, the runtime's find-or-create applies as normal.
 *
 * Idempotent: dedup happens on the SAME `companyNameKey()` the runtime uses
 * (script and app cannot disagree — the stated requirement), and the insert is
 * `createMany({ skipDuplicates })` against `@@unique([organizationId, nameKey])`,
 * so a re-run (or racing the live app) inserts nothing twice.
 *
 * Usage:
 *   npx tsx scripts/backfill-crm-companies.ts                # dry run (all orgs)
 *   npx tsx scripts/backfill-crm-companies.ts --write        # apply
 *   npx tsx scripts/backfill-crm-companies.ts --org <orgId>  # scope to one org
 *   npx tsx scripts/backfill-crm-companies.ts --min 2        # only names ≥2 contacts share
 */
import { db } from "../src/lib/db";
import { companyNameKey } from "../src/crm/services/company-service";

const write = process.argv.includes("--write");
const orgArgIdx = process.argv.indexOf("--org");
const orgFilter = orgArgIdx >= 0 ? process.argv[orgArgIdx + 1] : undefined;
const minArgIdx = process.argv.indexOf("--min");
const minContacts = minArgIdx >= 0 ? Math.max(1, Number(process.argv[minArgIdx + 1]) || 1) : 1;

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");
  if (minContacts > 1) console.log(`Only organizations named by ≥ ${minContacts} contacts\n`);

  const orgs = await db.organization.findMany({
    where: orgFilter ? { id: orgFilter } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let totalCreated = 0;

  for (const org of orgs) {
    const contacts = await db.contact.findMany({
      where: { organizationId: org.id, organization: { not: null } },
      select: { organization: true },
    });

    // Collapse to one candidate per normalized key; keep the display form most
    // contacts actually used (ties broken by first-seen) so "ABBOTT" doesn't win
    // over "Abbott" on a single shouty row.
    const byKey = new Map<string, Map<string, number>>();
    for (const c of contacts) {
      const raw = c.organization?.trim();
      if (!raw) continue;
      const key = companyNameKey(raw);
      if (!key) continue;
      const forms = byKey.get(key) ?? new Map<string, number>();
      forms.set(raw, (forms.get(raw) ?? 0) + 1);
      byKey.set(key, forms);
    }

    const existing = await db.crmCompany.findMany({
      where: { organizationId: org.id },
      select: { nameKey: true },
    });
    const existingKeys = new Set(existing.map((e) => e.nameKey));

    const candidates: Array<{ name: string; nameKey: string; contactCount: number }> = [];
    for (const [key, forms] of byKey) {
      if (existingKeys.has(key)) continue;
      const contactCount = [...forms.values()].reduce((a, b) => a + b, 0);
      if (contactCount < minContacts) continue;
      const name = [...forms.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      candidates.push({ name, nameKey: key, contactCount });
    }
    candidates.sort((a, b) => b.contactCount - a.contactCount);

    console.log(
      `Org "${org.name}" (${org.id}): ${contacts.length} contacts with an organization, ` +
        `${byKey.size} distinct names, ${existingKeys.size} companies already exist, ` +
        `${candidates.length} to create`,
    );
    for (const c of candidates.slice(0, 30)) {
      console.log(`  + ${c.name}  (${c.contactCount} contact${c.contactCount === 1 ? "" : "s"})`);
    }
    if (candidates.length > 30) console.log(`  … and ${candidates.length - 30} more`);

    if (write && candidates.length > 0) {
      const res = await db.crmCompany.createMany({
        data: candidates.map((c) => ({
          organizationId: org.id,
          name: c.name,
          nameKey: c.nameKey,
        })),
        skipDuplicates: true, // backed by @@unique([organizationId, nameKey])
      });
      totalCreated += res.count;
      console.log(`  ✓ created ${res.count}`);
    }
    console.log("");
  }

  console.log("─".repeat(60));
  console.log(
    write
      ? `Companies created: ${totalCreated}`
      : "Dry run only — re-run with --write to apply.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
