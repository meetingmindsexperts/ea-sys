/**
 * INBOUND import: external `contacts_centralv1` (EU Supabase) → EA-SYS `Contact`.
 *
 * This is the REVERSE of src/lib/contacts-central-sync.ts, which is outbound
 * only. Read the header of that file first — the merge semantics here are
 * deliberately its mirror image.
 *
 * Shape: this is a ONE-SHOT backfill, not a recurring sync. Run it once, then
 * the existing outbound sync keeps the mirror current forever. That matters,
 * because the `ea_synced` filter we select candidates with is single-use: the
 * nightly contacts-central-reconcile job pushes every Contact back to the mirror
 * at 02:24 UTC, which flips every imported row to `ea_synced = true`. There is
 * no second incremental run to be had without a new column on the target.
 *
 * Local only
 * ----------
 * Refuses unless DATABASE_URL resolves to localhost, and refuses the known prod
 * project ref. There is no escape hatch: the local DB is a restored copy of
 * production (docs/LOCAL_DEV_DATABASE.md), so a test here is realistic AND
 * reversible, which is the whole point. Reads against the EU mirror are GET-only
 * regardless of flags — this script never writes to the mirror.
 *
 * Merge semantics (mirror image of the outbound sync)
 * ---------------------------------------------------
 *   - New email  → create a Contact.
 *   - Existing   → ENRICH ONLY. Fill blanks, union `tags`, never overwrite a
 *                  populated field. A 2018 mirror row must not clobber a fresh
 *                  2026 registration's phone number.
 *   - `eventIds` → NEVER written. The mirror's `events_attended` holds event
 *                  NAMES; our column holds cuids. Guessing the mapping would
 *                  silently attach people to the wrong events.
 *
 * Email is lowercased on the way in. The mirror's PK is case-sensitive and ours
 * is not, so ~3.5k people who exist there twice (`A.b@x` and `a.b@x`) collapse
 * into one Contact here. That is a feature: the second occurrence enriches the
 * first rather than duplicating it.
 *
 * Tags are sanitized on the way in (see `sanitizeImportedTag`): the mirror
 * carries `{"name":"…"}` JSON blobs and bare machine ids, both of which would
 * otherwise render as literal pills in the contacts tag filter.
 *
 * Rows this script CREATES are tagged `central-import` so the batch stays
 * identifiable and deletable. Rows it merely ENRICHES are not tagged — the tag
 * has to mean "this row would not exist without the import" for the undo to be
 * safe. `Contact` has no externalSource column, so a tag is the only provenance
 * handle available. Enrichment is therefore not reversible, which is acceptable
 * because it only ever filled blanks.
 *
 * Usage:
 *   npx tsx scripts/dev-import-contacts-central.ts                    # dry run, 5 rows
 *   npx tsx scripts/dev-import-contacts-central.ts --count            # totals only
 *   npx tsx scripts/dev-import-contacts-central.ts --limit 60000      # full dry run
 *   npx tsx scripts/dev-import-contacts-central.ts --limit 60000 --write
 *   npx tsx scripts/dev-import-contacts-central.ts --include-synced   # ignore the ea_synced filter
 *   npx tsx scripts/dev-import-contacts-central.ts --purge-blocked   # clean rows already imported
 *   npx tsx scripts/dev-import-contacts-central.ts --purge-blocked --write
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { parseAttendeeRole } from "@/lib/schemas";
import { screenContact } from "@/lib/contact-import-blocklist";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/** master prod Supabase project ref — mirrors scripts/guard-db-target.sh */
const PROD_MARKER = "nifaqvgnfwddgsusxapy";
/** Provenance tag stamped on every row this script touches. */
const IMPORT_TAG = "central-import";
/** Ceiling so a mistyped --limit cannot run away. Table is ~60k. */
const MAX_LIMIT = 200_000;
/** PostgREST returns at most 1000 rows per request on this project. */
const PAGE_SIZE = 1000;
/** Print one line per row only for small runs; otherwise print progress. */
const VERBOSE_THRESHOLD = 50;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function assertLocalDatabase(): void {
  // Mirrors scripts/dev-create-admin.ts, which has four checks. This one writes
  // and deletes contacts, so it gets the same four.
  if (process.env.NODE_ENV === "production") {
    throw new Error("[import-central] NODE_ENV=production. Refusing — this script writes and deletes contacts.");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[import-central] DATABASE_URL is not set. Refusing.");
  if (url.includes(PROD_MARKER)) {
    throw new Error(
      `[import-central] DATABASE_URL points at the production Supabase project (${PROD_MARKER}). Refusing — this script writes contacts.`,
    );
  }
  // Parse rather than substring-match: "…@evil.example/db?host=localhost" must
  // not pass, and a bare `.includes("localhost")` would let it.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("[import-central] DATABASE_URL is not a parseable URL. Refusing.");
  }
  // URL.hostname returns IPv6 literals WITH brackets ("[::1]"), so comparing to
  // a bare "::1" is dead code — strip them before the check.
  host = host.replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `[import-central] DATABASE_URL host is "${host}", not localhost. Refusing — this script only ever runs against a local database.`,
    );
  }
}

interface MirrorRow {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  organization_name: string | null;
  job_title: string | null;
  mobile: string | null;
  city: string | null;
  country: string | null;
  speciality: string | null;
  role: string | null;
  tags: string[] | null;
  registration_type: string[] | null;
}

const SELECT_COLS = [
  "email",
  "first_name",
  "last_name",
  "organization_name",
  "job_title",
  "mobile",
  "city",
  "country",
  "speciality",
  "role",
  "tags",
  "registration_type",
].join(",");

/** Trim to null. Mirrors `nz()` in the outbound sync. */
const nz = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * The mirror's `tags` array carries two shapes we must not store verbatim.
 *
 * 1. JSON blobs: `{"name":"MASH in Focus"}`. A BigMarker-style export where the
 *    source held `{id, name}` objects and each field got serialized as its own
 *    tag, so they arrive in pairs — one readable label and one opaque id.
 *    Storing the blob means the tag filter renders `{"name":"…"}` as a pill.
 * 2. Bare machine ids: `53be47fbc530`. Meaningless to a human, and they double
 *    the size of the tag vocabulary for no benefit.
 *
 * Deliberately does NOT apply `normalizeTag` from @/lib/utils. That Title-Cases,
 * and rewriting the mirror's existing casing would break the downstream n8n /
 * Webflow tag filter, which matches case-sensitively. Unwrap and drop only.
 *
 * Returns null for anything that should not become a tag.
 */
const MACHINE_ID_RE = /^[0-9a-f]{10,}$/i;

export function sanitizeImportedTag(raw: string): string | null {
  let value = (raw ?? "").trim();
  if (!value) return null;

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      const name =
        parsed && typeof parsed === "object" && "name" in parsed
          ? String((parsed as { name: unknown }).name ?? "").trim()
          : "";
      if (!name) return null;
      value = name;
    } catch {
      return null; // unparseable blob is not a tag
    }
  }

  if (MACHINE_ID_RE.test(value)) return null;
  return value;
}

function mirrorConfig() {
  const base = (process.env.CONTACTS_CENTRAL_URL || "").replace(/\/+$/, "");
  const key = process.env.CONTACTS_CENTRAL_SERVICE_KEY || "";
  const table = process.env.CONTACTS_CENTRAL_TABLE || "contacts_centralv1";
  if (!base || !key) {
    throw new Error(
      "[import-central] CONTACTS_CENTRAL_URL / CONTACTS_CENTRAL_SERVICE_KEY are not set. Put them in .env.local.",
    );
  }
  return { base, key, table };
}

const candidateFilter = () => (flag("include-synced") ? "" : "&ea_synced=not.is.true");

async function fetchTotals() {
  const { base, key, table } = mirrorConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" };

  async function countWhere(filter: string): Promise<number | null> {
    // limit=1 keeps the body tiny; the count rides in Content-Range.
    const res = await fetch(`${base}/rest/v1/${table}?select=email&limit=1${filter}`, { headers });
    if (!res.ok) {
      throw new Error(`[import-central] mirror read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const total = res.headers.get("content-range")?.split("/")[1]; // "0-0/12345"
    return total && total !== "*" ? Number(total) : null;
  }

  return { all: await countWhere(""), candidates: await countWhere("&ea_synced=not.is.true") };
}

async function fetchPage(offset: number, limit: number): Promise<MirrorRow[]> {
  const { base, key, table } = mirrorConfig();
  const url = `${base}/rest/v1/${table}?select=${SELECT_COLS}&limit=${limit}&offset=${offset}&order=email.asc${candidateFilter()}`;
  const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    throw new Error(`[import-central] mirror read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as MirrorRow[];
}

interface Mapped {
  email: string;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  specialty: string | null;
  registrationType: string | null;
  role: ReturnType<typeof parseAttendeeRole>;
  tags: string[];
}

/** Fields we enrich (fill-if-blank) on an existing Contact. */
const ENRICHABLE = [
  "organization",
  "jobTitle",
  "phone",
  "city",
  "country",
  "specialty",
  "registrationType",
] as const;

/** Map a mirror row, or explain why it cannot be mapped. */
function mapRow(r: MirrorRow): { ok: true; value: Mapped } | { ok: false; reason: string } {
  const email = nz(r.email)?.toLowerCase();
  if (!email) return { ok: false, reason: "no email" };

  // firstName/lastName are NOT nullable on Contact. Inventing a placeholder is
  // worse than skipping: it puts a fake name in the CRM and in every email that
  // greets from it (this is exactly the class that produced the "TBC TBC"
  // contacts already sitting in the org contact book).
  const firstName = nz(r.first_name);
  const lastName = nz(r.last_name);
  if (!firstName || !lastName) return { ok: false, reason: "missing first/last name" };

  // Do-not-import screen. The mirror carried spam whose `firstName` was a
  // redirector URL, and harvested bounce mailboxes recorded as surnames. A name
  // is merged into email greetings and printed on badges, so it is an output
  // surface and gets screened like one.
  const screen = screenContact({
    email,
    firstName,
    lastName,
    organization: nz(r.organization_name),
    jobTitle: nz(r.job_title),
  });
  if (screen.blocked) return { ok: false, reason: `blocked: ${screen.reason}` };

  // IMPORT_TAG is deliberately NOT added here — it is stamped only on rows this
  // script CREATES (see the create block). If it were also added to rows we
  // merely enrich, the documented undo ("delete every Contact tagged
  // central-import") would delete pre-existing contacts that already had their
  // own history. The tag has to mean "this row would not exist without the
  // import" or it is not safe to delete by.
  const tags = [...new Set((r.tags ?? []).map(sanitizeImportedTag).filter((t): t is string => t !== null))];

  return {
    ok: true,
    value: {
      email,
      firstName,
      lastName,
      organization: nz(r.organization_name),
      jobTitle: nz(r.job_title),
      phone: nz(r.mobile),
      city: nz(r.city),
      country: nz(r.country),
      specialty: nz(r.speciality),
      // registration_type is an array on the mirror, a scalar here. First wins.
      registrationType: nz(r.registration_type?.[0] ?? null),
      role: parseAttendeeRole(r.role),
      tags,
    },
  };
}

/**
 * Collapse rows that map to the same lowercased email within one page. The
 * mirror's PK is case-sensitive, so `A.b@x` and `a.b@x` are two rows there and
 * one Contact here. First occurrence wins for scalars, tags union — the same
 * enrich-only rule applied to an existing row.
 */
function collapseByEmail(rows: Mapped[]): Mapped[] {
  const byEmail = new Map<string, Mapped>();
  for (const r of rows) {
    const seen = byEmail.get(r.email);
    if (!seen) {
      byEmail.set(r.email, r);
      continue;
    }
    for (const f of ENRICHABLE) if (!seen[f] && r[f]) (seen[f] as string | null) = r[f];
    if (!seen.role && r.role) seen.role = r.role;
    seen.tags = [...new Set([...seen.tags, ...r.tags])];
  }
  return [...byEmail.values()];
}

/**
 * Delete Contacts already in the database that the do-not-import screen would
 * refuse today. Needed because the screen was written after the first import
 * ran, and because the blocklist grows: adding an address to it should be able
 * to clean history, not only guard the future.
 *
 * Reports before it deletes and honours --write like everything else here.
 */
async function purgeBlocked(db: PrismaClient, organizationId: string, write: boolean) {
  const BATCH = 1000;
  const doomed: {
    reason: string;
    detail: string;
    row: Record<string, unknown>;
    crmContactIds: string[];
  }[] = [];
  let cursor: string | undefined;

  // Scoped to imported rows by default. The screen is a heuristic tuned for
  // untrusted bulk data; that rationale does not transfer to a contact created
  // by a real registration, and the script is otherwise careful that the tag
  // means "would not exist without the import".
  const allContacts = flag("all-contacts");
  const scope = allContacts ? {} : { tags: { has: IMPORT_TAG } };

  for (;;) {
    const batch = await db.contact.findMany({
      where: { organizationId, ...scope },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;
    for (const c of batch) {
      const screen = screenContact(c);
      // Keep the WHOLE row, not just the id. A deletion you cannot inspect
      // afterwards is a deletion you cannot defend, and this screen is a
      // heuristic — it will occasionally be wrong about a real person.
      //
      // CrmContact.contactId is `onDelete: SetNull`, so a delete severs the
      // CRM↔event-contact link with no application code firing and nothing in
      // the Contact row recording it. Capture the referencing ids or the link
      // is unrecoverable even with a full row backup.
      if (screen.blocked) {
        const crmContactIds = (
          await db.crmContact.findMany({ where: { contactId: c.id }, select: { id: true } })
        ).map((r) => r.id);
        doomed.push({ reason: screen.reason, detail: screen.detail, row: c, crmContactIds });
      }
    }
    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH) break;
  }

  const byReason = new Map<string, number>();
  for (const d of doomed) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);

  console.log(`\n=== do-not-import purge ===`);
  console.log(`  scope:             ${allContacts ? "ALL contacts in the org (--all-contacts)" : `rows tagged "${IMPORT_TAG}"`}`);
  console.log(`  matching contacts: ${doomed.length}`);
  const withCrm = doomed.filter((d) => d.crmContactIds.length > 0).length;
  if (withCrm > 0) console.log(`  ⚠ ${withCrm} of them are linked from CrmContact — that link is NOT restorable by re-import`);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${reason.padEnd(20)} ${count}`);
  }
  console.log(`\n  first 10:`);
  for (const d of doomed.slice(0, 10)) {
    // Defanged so a spam URL in the output cannot be clicked from a terminal.
    const defang = (s: string) => s.replace(/https?:\/\//gi, "hxxps://").replace(/\./g, "[.]");
    console.log(`      ${defang(String(d.row.email))}  ${d.reason}  ${defang(d.detail)}`);
  }

  if (!write) {
    console.log(`\n  Dry run. Re-run with --write to delete.`);
    return;
  }
  if (doomed.length === 0) return;

  // Quarantine before deleting. Restoring is then a matter of reading this file
  // back, which is what makes running the purge a reversible decision.
  //
  // The filename is timestamped and NEVER overwritten. The first version used a
  // fixed name and `writeFile`, which truncates: add one address to the
  // blocklist, re-run, and the previous run's rows — the only copy of what was
  // deleted — are replaced by the new result. That silently removed the very
  // property the comment above claims.
  //
  // The path is a basename under cwd, not caller-supplied, so `--quarantine
  // ../../x.json` cannot traverse and a custom name cannot escape the
  // `contacts-quarantine*.json` gitignore rule while holding ~57k people's PII.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = path.resolve(process.cwd(), `contacts-quarantine-${stamp}.json`);
  await writeFile(quarantinePath, JSON.stringify(doomed, null, 2), {
    encoding: "utf8",
    flag: "wx", // fail rather than clobber
    mode: 0o600, // PII: owner-only, not the 0644 default
  });
  console.log(`\n  quarantined ${doomed.length} row(s) → ${quarantinePath}`);

  let deleted = 0;
  const ids = doomed.map((d) => String(d.row.id));
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await db.contact.deleteMany({ where: { id: { in: ids.slice(i, i + BATCH) } } });
    deleted += res.count;
  }
  console.log(`  deleted: ${deleted}`);
}

async function main() {
  assertLocalDatabase();
  const db = new PrismaClient();

  const write = flag("write");
  const limitRaw = Number(arg("limit") ?? 5);
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 5, MAX_LIMIT);
  const verbose = limit <= VERBOSE_THRESHOLD;

  try {
    const totals = await fetchTotals();
    console.log("\n=== mirror totals ===");
    console.log(`  rows in ${mirrorConfig().table}: ${totals.all ?? "unknown"}`);
    console.log(`  not yet synced from EA-SYS:     ${totals.candidates ?? "unknown"}`);

    if (flag("count")) return;

    const org = await db.organization.findFirst({ select: { id: true, name: true } });
    if (!org) throw new Error("[import-central] no Organization row found in the local database.");

    if (flag("purge-blocked")) {
      await purgeBlocked(db, org.id, write);
      return;
    }

    const before = await db.contact.count({ where: { organizationId: org.id } });

    console.log(`\n  target org:     ${org.name} (${org.id})`);
    console.log(`  contacts now:   ${before}`);
    console.log(`  mode:           ${write ? "WRITE" : "DRY RUN"}`);
    console.log(`  limit:          ${limit}`);
    console.log(`  filter:         ${flag("include-synced") ? "all rows" : "candidates only (ea_synced not true)"}\n`);

    let fetched = 0;
    let created = 0;
    let enriched = 0;
    let unchanged = 0;
    let skipped = 0;
    let collapsed = 0;
    const skipReasons = new Map<string, number>();
    const startedAt = Date.now();

    for (let offset = 0; fetched < limit; ) {
      const pageSize = Math.min(PAGE_SIZE, limit - fetched);
      const raw = await fetchPage(offset, pageSize);
      // Terminate on an EMPTY page only. A SHORT page must not end the loop:
      // if PostgREST's max-rows is ever configured below PAGE_SIZE, page one
      // comes back short and we would stop after ~1000 of 57,000 rows while
      // reporting success.
      if (raw.length === 0) break;
      offset += raw.length;
      fetched += raw.length;

      // 1. Map, dropping rows we cannot represent.
      const mappedRows: Mapped[] = [];
      for (const r of raw) {
        const m = mapRow(r);
        if (!m.ok) {
          skipped++;
          skipReasons.set(m.reason, (skipReasons.get(m.reason) ?? 0) + 1);
          if (verbose) console.log(`  SKIP    ${r.email ?? "(no email)"} — ${m.reason}`);
          continue;
        }
        mappedRows.push(m.value);
      }

      // 2. Collapse case-duplicates inside this page.
      const rows = collapseByEmail(mappedRows);
      collapsed += mappedRows.length - rows.length;

      // 3. One lookup for the whole page instead of one per row.
      const existing = await db.contact.findMany({
        where: { organizationId: org.id, email: { in: rows.map((r) => r.email) } },
        select: {
          id: true, email: true, organization: true, jobTitle: true, phone: true,
          city: true, country: true, specialty: true, registrationType: true,
          role: true, tags: true,
        },
      });
      const existingByEmail = new Map(existing.map((e) => [e.email, e]));

      const toCreate: Mapped[] = [];
      const toUpdate: { id: string; data: Record<string, unknown>; email: string }[] = [];

      for (const m of rows) {
        const prev = existingByEmail.get(m.email);
        if (!prev) {
          toCreate.push(m);
          if (verbose) {
            console.log(`  CREATE  ${m.email}  ${m.firstName} ${m.lastName}${m.organization ? ` · ${m.organization}` : ""}${m.country ? ` · ${m.country}` : ""}`);
          }
          continue;
        }
        // Enrich only: fill blanks, union tags, never overwrite.
        const data: Record<string, unknown> = {};
        for (const f of ENRICHABLE) if (m[f] && !prev[f]) data[f] = m[f];
        if (m.role && !prev.role) data.role = m.role;
        const mergedTags = [...new Set([...prev.tags, ...m.tags])];
        if (mergedTags.length !== prev.tags.length) data.tags = mergedTags;

        if (Object.keys(data).length === 0) {
          unchanged++;
          if (verbose) console.log(`  SAME    ${m.email}  (exists, nothing blank to fill)`);
          continue;
        }
        toUpdate.push({ id: prev.id, data, email: m.email });
        if (verbose) console.log(`  ENRICH  ${m.email}  ${Object.keys(data).join(", ")}`);
      }

      if (write) {
        if (toCreate.length > 0) {
          await db.contact.createMany({
            data: toCreate.map((m) => ({
              organizationId: org.id,
              email: m.email,
              firstName: m.firstName,
              lastName: m.lastName,
              organization: m.organization,
              jobTitle: m.jobTitle,
              phone: m.phone,
              city: m.city,
              country: m.country,
              specialty: m.specialty,
              registrationType: m.registrationType,
              role: m.role,
              // Provenance stamped ONLY on rows this script creates, so the
              // undo is safe to run. See the note in mapRow().
              tags: [...new Set([...m.tags, IMPORT_TAG])],
              // eventIds deliberately left empty — see the header.
            })),
            skipDuplicates: true,
          });
        }
        for (const u of toUpdate) {
          await db.contact.update({ where: { id: u.id }, data: u.data });
        }
      }

      created += toCreate.length;
      enriched += toUpdate.length;

      if (!verbose) {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.log(`  …${fetched} fetched · ${created} create · ${enriched} enrich · ${unchanged} same · ${skipped} skip · ${collapsed} collapsed  (${secs}s)`);
      }

    }

    const after = write ? await db.contact.count({ where: { organizationId: org.id } }) : before;

    console.log(`\n=== ${write ? "applied" : "would apply"} ===`);
    console.log(`  fetched:        ${fetched}`);
    console.log(`  created:        ${created}`);
    console.log(`  enriched:       ${enriched}`);
    console.log(`  unchanged:      ${unchanged}`);
    console.log(`  skipped:        ${skipped}`);
    for (const [r, n] of skipReasons) console.log(`      ${r}: ${n}`);
    console.log(`  case-collapsed: ${collapsed}  (same person, two rows in the mirror)`);
    console.log(`  contacts:       ${before} → ${after}`);
    console.log(`  elapsed:        ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    if (!write) console.log(`\n  Dry run. Re-run with --write to apply.`);
    else console.log(`\n  Undo:  delete every Contact carrying the "${IMPORT_TAG}" tag.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
