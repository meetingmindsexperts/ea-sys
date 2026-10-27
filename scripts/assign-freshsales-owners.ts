/**
 * One-off: give CRM accounts and contacts their Freshsales "Sales owner"
 * (Oct 27, 2026).
 *
 * WHY: the first Freshsales import left 3,303 of 3,336 contacts unowned, and
 * accounts had no owner field until migration 20261027120000. The data file
 * (scripts/data/freshsales-owners-2026-09-18.csv: Type, Freshsales id, Sales
 * owner) holds only record ids and staff names, derived from the Freshsales
 * Accounts and Contacts exports of Sep 18, 2026.
 *
 * RULES (owner, Oct 27, 2026):
 *   - Freshsales wins: an existing different owner is replaced and printed.
 *   - An owner with no CRM-capable EA-SYS user (Lina Alaa Eldin today) is
 *     skipped and counted; re-run after inviting her and her rows follow.
 *   - Names resolve through the import's own makeOwnerResolver, so this script
 *     and the importer cannot disagree about who "Saleh Mahmoud" is.
 *
 * Like link-freshsales-account-contacts.ts: each write is guarded on the
 * updatedAt read at startup (an edit made mid-run is skipped and listed), a
 * row on the import's update path also gets lastImportedAt stamped so the next
 * import keeps treating it as Freshsales-owned, every change lands on the
 * record's History, and a History failure stops the run. Idempotent.
 *
 * Usage (on the box):
 *   docker exec ea-sys-worker npx tsx scripts/assign-freshsales-owners.ts           # dry run
 *   docker exec ea-sys-worker npx tsx scripts/assign-freshsales-owners.ts --write
 *   ... --file <path.csv>   ... --org <orgId>
 */
import { readFileSync } from "fs";
import path from "path";
import { db } from "../src/lib/db";
import { parseCSV } from "../src/lib/csv-parser";
import { recordCrmActivityBulk, type CrmActivityEntry } from "../src/crm/lib/crm-activity";
import { decideImportAction } from "../src/crm/lib/freshsales-import";
import { makeOwnerResolver } from "../src/crm/services/crm-import-service";
import {
  planOwnerAssignments,
  readOwnerRows,
  type OwnerRecordType,
  type OwnerRow,
} from "../src/crm/lib/freshsales-owner-assign";

const FRESHSALES = "freshsales";
const SOURCE = "freshsales-owners";
const BATCH = 200;

const write = process.argv.includes("--write");
const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = path.resolve(argValue("--file") ?? "scripts/data/freshsales-owners-2026-09-18.csv");

interface OwnedRecord {
  id: string;
  /** For the dry-run printout only. */
  label: string;
  externalId: string | null;
  ownerId: string | null;
  updatedAt: Date;
  lastImportedAt: Date | null;
}

async function resolveOrg(): Promise<string> {
  const explicit = argValue("--org");
  if (explicit) return explicit;
  const orgs = await db.crmContact.findMany({
    where: { externalSource: FRESHSALES },
    distinct: ["organizationId"],
    select: { organizationId: true },
  });
  if (orgs.length !== 1) throw new Error(`${orgs.length} organisations have Freshsales contacts; pass --org <id>`);
  return orgs[0]!.organizationId;
}

async function loadRecords(type: OwnerRecordType, organizationId: string, ids: string[]): Promise<OwnedRecord[]> {
  const select = { id: true, externalId: true, ownerId: true, updatedAt: true, lastImportedAt: true } as const;
  const where = { organizationId, externalSource: FRESHSALES, externalId: { in: ids } };
  if (type === "account") {
    const rows = await db.crmCompany.findMany({ where, select: { ...select, name: true } });
    return rows.map(({ name, ...r }) => ({ ...r, label: name }));
  }
  const rows = await db.crmContact.findMany({ where, select: { ...select, firstName: true, lastName: true } });
  return rows.map(({ firstName, lastName, ...r }) => ({ ...r, label: `${firstName} ${lastName}` }));
}

/** Guarded on the updatedAt we read, so a mid-run edit is skipped, never swallowed. */
function guardedWrite(type: OwnerRecordType, read: OwnedRecord, ownerId: string, now: Date) {
  const stamp = decideImportAction(read) === "update" ? { lastImportedAt: now } : {};
  const args = { where: { id: read.id, updatedAt: read.updatedAt }, data: { ownerId, ...stamp } };
  if (type === "account") return db.crmCompany.updateMany(args);
  return db.crmContact.updateMany(args);
}

async function runType(
  type: OwnerRecordType,
  rows: OwnerRow[],
  organizationId: string,
  resolve: (name: string) => string | null,
  nameOf: Map<string, string>,
  ambiguous: Set<string>,
) {
  const label = type === "account" ? "Accounts" : "Contacts";
  const mine = rows.filter((r) => r.type === type);
  const records = await loadRecords(type, organizationId, mine.map((r) => r.externalId));
  const byExt = new Map(records.map((r) => [r.externalId!, r]));
  const byId = new Map(records.map((r) => [r.id, r]));
  const plan = planOwnerAssignments(mine, byExt, resolve);
  const replaced = plan.writes.filter((w) => w.previousOwnerId);

  console.log(`\n== ${label} (${mine.length} rows in the file) ==`);
  console.log(`To assign (no owner yet): ${plan.writes.length - replaced.length}`);
  console.log(`To REPLACE an existing owner: ${replaced.length}`);
  for (const w of replaced) {
    console.log(`  ${byId.get(w.id)!.label}: ${nameOf.get(w.previousOwnerId!) ?? w.previousOwnerId} -> ${nameOf.get(w.ownerId)}`);
  }
  console.log(`Already owned correctly: ${plan.alreadyOwned}`);
  console.log(`Skipped, not in EA-SYS: ${plan.missingRecords}`);
  for (const [name, n] of plan.unmatchedOwners) {
    const why = ambiguous.has(name) ? "matches more than one EA-SYS user" : "no EA-SYS user";
    console.log(`Skipped, ${why} for "${name}": ${n}`);
  }

  if (!write || plan.writes.length === 0) return;

  let written = 0;
  const changedSinceRead: string[] = [];
  for (let i = 0; i < plan.writes.length; i += BATCH) {
    const batch = plan.writes.slice(i, i + BATCH);
    const now = new Date();
    const results = await db.$transaction(batch.map((w) => guardedWrite(type, byId.get(w.id)!, w.ownerId, now)));
    const done = batch.filter((w, j) => {
      if (results[j]!.count === 1) return true;
      changedSinceRead.push(w.id);
      return false;
    });
    const activity: CrmActivityEntry[] = done.map((w) => ({
      organizationId,
      entityType: type === "account" ? "COMPANY" : "CONTACT",
      entityId: w.id,
      action: "UPDATE",
      actorId: null,
      // Owner NAMES, not ids, so the History timeline reads.
      changes: {
        source: SOURCE,
        changes: {
          ownerId: {
            from: w.previousOwnerId ? nameOf.get(w.previousOwnerId) ?? w.previousOwnerId : null,
            to: nameOf.get(w.ownerId) ?? w.ownerId,
          },
        },
      },
    }));
    // recordCrmActivityBulk never throws; check what it wrote (see the header).
    const recorded = (await recordCrmActivityBulk(activity)) as { count?: number } | undefined;
    if (activity.length > 0 && recorded?.count !== activity.length) {
      throw new Error(`History write failed for ${label} batch at ${i}: the owners are saved, the timeline entries are not`);
    }
    written += done.length;
    console.log(`  wrote ${written}/${plan.writes.length}`);
  }
  console.log(`Done: ${written} ${label.toLowerCase()} given an owner.`);
  if (changedSinceRead.length > 0) {
    console.log(`Skipped ${changedSinceRead.length} edited while running; re-run to pick them up: ${changedSinceRead.join(", ")}`);
  }
}

async function main() {
  console.log(write ? "Mode: WRITE" : "Mode: DRY RUN (pass --write to apply)");
  const parsed = parseCSV(readFileSync(file, "utf8"), { maxRows: 50_000 });
  if (parsed.error) throw new Error(parsed.error);
  const rows = readOwnerRows(parsed.headers, parsed.rows);
  if ("error" in rows) throw new Error(rows.error);
  const organizationId = await resolveOrg();
  console.log(`File: ${file}\nRows: ${rows.length}\nOrganisation: ${organizationId}`);

  const resolver = await makeOwnerResolver(organizationId);
  // The resolver counts a name matching two users as "ambiguous"; remember which
  // names those were so the printout does not call them "no EA-SYS user".
  const ambiguous = new Set<string>();
  const resolve = (name: string) => {
    const before = resolver.ambiguous;
    const id = resolver.resolve(undefined, name);
    if (resolver.ambiguous > before) ambiguous.add(name);
    return id;
  };
  const users = await db.user.findMany({
    where: { organizationId },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim()]));

  await runType("account", rows, organizationId, resolve, nameOf, ambiguous);
  await runType("contact", rows, organizationId, resolve, nameOf, ambiguous);
  if (!write) console.log("\nDry run only. Re-run with --write to apply.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
