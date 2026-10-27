/**
 * One-off: link CRM contacts to their accounts from Freshsales'
 * `Account_contacts.csv` (Oct 27, 2026).
 *
 * WHY: Freshsales exports the contact↔account relation as its own file; the
 * Contacts export has no account column, so the first import left 3,331 of
 * 3,336 contacts with no account. The mapping is resolved by Freshsales ids
 * (`externalId` on both sides), never by name. Planning lives in
 * src/crm/lib/freshsales-account-links.ts (pure, tested).
 *
 * RULES (owner, Oct 27, 2026):
 *   - The primary account wins for a contact with several; no primary = report.
 *   - The file wins: an existing DIFFERENT link is moved and printed.
 *   - Every write is recorded on the contact's History timeline.
 *
 * DOES NOT break the import's Freshsales-wins rule: a write bumps updatedAt,
 * which would make the next import treat the contact as "edited in EA-SYS" and
 * skip it. So a contact on the update path also gets lastImportedAt stamped.
 * One already edited in EA-SYS (kept-local) or EA-born (enrich) keeps its
 * lastImportedAt, so its human edits stay protected.
 *
 * Idempotent: a re-run finds every link already set and writes nothing.
 *
 * Usage (on the box):
 *   docker exec ea-sys-worker npx tsx scripts/link-freshsales-account-contacts.ts           # dry run
 *   docker exec ea-sys-worker npx tsx scripts/link-freshsales-account-contacts.ts --write
 *   ... --file <path.csv>   (default: scripts/data/freshsales-account-contacts-2026-09-18.csv)
 *   ... --org <orgId>       (required only when more than one org has Freshsales contacts)
 */
import { readFileSync } from "fs";
import path from "path";
import { db } from "../src/lib/db";
import { parseCSV } from "../src/lib/csv-parser";
import { recordCrmActivityBulk, type CrmActivityEntry } from "../src/crm/lib/crm-activity";
import { decideImportAction } from "../src/crm/lib/freshsales-import";
import { planAccountLinks, readAccountContactRows } from "../src/crm/lib/freshsales-account-links";

const FRESHSALES = "freshsales";
const SOURCE = "freshsales-account-links";
const BATCH = 200;

const write = process.argv.includes("--write");
const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = path.resolve(argValue("--file") ?? "scripts/data/freshsales-account-contacts-2026-09-18.csv");

async function resolveOrg(): Promise<string> {
  const explicit = argValue("--org");
  if (explicit) return explicit;
  const orgs = await db.crmContact.findMany({
    where: { externalSource: FRESHSALES },
    distinct: ["organizationId"],
    select: { organizationId: true },
  });
  if (orgs.length !== 1) {
    throw new Error(`${orgs.length} organisations have Freshsales contacts; pass --org <id>`);
  }
  return orgs[0]!.organizationId;
}

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");
  const parsed = parseCSV(readFileSync(file, "utf8"));
  if (parsed.error) throw new Error(parsed.error);
  const rows = readAccountContactRows(parsed.headers, parsed.rows);
  if ("error" in rows) throw new Error(rows.error);
  const organizationId = await resolveOrg();
  console.log(`File: ${file}\nRows: ${rows.length}\nOrganisation: ${organizationId}\n`);

  const [contacts, accounts] = await Promise.all([
    db.crmContact.findMany({
      where: { organizationId, externalSource: FRESHSALES, externalId: { in: rows.map((r) => r.contactExternalId) } },
      select: {
        id: true, externalId: true, companyId: true, firstName: true, lastName: true,
        updatedAt: true, lastImportedAt: true, archivedAt: true,
      },
    }),
    db.crmCompany.findMany({
      where: { organizationId, externalSource: FRESHSALES, externalId: { in: rows.map((r) => r.accountExternalId) } },
      select: { id: true, externalId: true, name: true, archivedAt: true },
    }),
  ]);
  const contactByExt = new Map(contacts.map((c) => [c.externalId!, c]));
  const accountByExt = new Map(accounts.map((a) => [a.externalId!, a]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const plan = planAccountLinks(rows, contactByExt, accountByExt);
  const moves = plan.writes.filter((w) => w.previousCompanyId);
  const previousNames = new Map(
    (await db.crmCompany.findMany({
      where: { id: { in: moves.map((m) => m.previousCompanyId!) } },
      select: { id: true, name: true },
    })).map((c) => [c.id, c.name]),
  );

  console.log(`To link (no account yet): ${plan.writes.length - moves.length}`);
  console.log(`To MOVE to a different account: ${moves.length}`);
  for (const m of moves) {
    const c = contactById.get(m.contactId)!;
    console.log(`  ${c.firstName} ${c.lastName}: ${previousNames.get(m.previousCompanyId!) ?? m.previousCompanyId} -> ${accountById.get(m.companyId)?.name}`);
  }
  console.log(`Already linked correctly: ${plan.alreadyLinked}`);
  console.log(`Skipped, contact not in EA-SYS: ${plan.missingContact.length}`);
  console.log(`Skipped, account not in EA-SYS: ${plan.missingAccount.length}`);
  console.log(`Skipped, no primary account in the file: ${plan.noPrimary.length}`);
  console.log(`Skipped, two different primary accounts in the file: ${plan.conflictingPrimary.length}`);
  // Archived rows are written like the importer writes them; shown so it is a decision.
  console.log(`Of the writes, archived contacts: ${plan.writes.filter((w) => contactById.get(w.contactId)!.archivedAt).length}`);
  console.log(`Of the writes, to an archived account: ${plan.writes.filter((w) => accountById.get(w.companyId)!.archivedAt).length}`);

  if (!write || plan.writes.length === 0) {
    console.log(write ? "\nNothing to write." : "\nDry run only. Re-run with --write to apply.");
    return;
  }

  let written = 0;
  const changedSinceRead: string[] = [];
  for (let i = 0; i < plan.writes.length; i += BATCH) {
    const batch = plan.writes.slice(i, i + BATCH);
    const now = new Date();
    const results = await db.$transaction(
      batch.map((w) => {
        const read = contactById.get(w.contactId)!;
        // Keep the Freshsales-wins rule intact (see the header).
        const stamp = decideImportAction(read) === "update" ? { lastImportedAt: now } : {};
        // Guarded on the updatedAt we read: a contact edited in the UI since
        // then is skipped and listed, so the stamp can never swallow that edit.
        return db.crmContact.updateMany({
          where: { id: w.contactId, updatedAt: read.updatedAt },
          data: { companyId: w.companyId, ...stamp },
        });
      }),
    );
    const done = batch.filter((w, j) => {
      if (results[j]!.count === 1) return true;
      changedSinceRead.push(w.contactId);
      return false;
    });
    const activity: CrmActivityEntry[] = done.map((w) => ({
      organizationId,
      entityType: "CONTACT",
      entityId: w.contactId,
      action: "UPDATE",
      actorId: null,
      // Account NAMES, not ids, so the History timeline reads.
      changes: {
        source: SOURCE,
        changes: {
          companyId: {
            from: w.previousCompanyId ? previousNames.get(w.previousCompanyId) ?? w.previousCompanyId : null,
            to: accountById.get(w.companyId)!.name,
          },
        },
      },
    }));
    // recordCrmActivityBulk never throws, so check what it wrote: the contacts
    // are already linked, and a re-run would not record the history again.
    const recorded = (await recordCrmActivityBulk(activity)) as { count?: number } | undefined;
    if (activity.length > 0 && recorded?.count !== activity.length) {
      throw new Error(`History write failed for batch at ${i}: the links are saved, the timeline entries are not`);
    }
    written += done.length;
    console.log(`  wrote ${written}/${plan.writes.length}`);
  }
  console.log(`\nDone: ${written} contact(s) linked.`);
  if (changedSinceRead.length > 0) {
    console.log(`Skipped ${changedSinceRead.length} edited while running; re-run to pick them up: ${changedSinceRead.join(", ")}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
