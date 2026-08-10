/**
 * Freshsales CSV import — the orchestration layer. SERVER ONLY.
 *
 * The pure decisions (header synonyms, row mapping, the re-import conflict
 * rule) live in src/crm/lib/freshsales-import.ts; this file does the reads,
 * the writes and the report.
 *
 * DELIBERATE EXCEPTION to the "single-create goes through the domain service"
 * rule: like every other bulk import in this codebase (CSV registrations,
 * create_speakers_bulk), the importer writes rows directly — it needs per-row
 * error capture, historical timestamps (a deal won last March must carry last
 * March's wonAt, which closeDeal() cannot produce), enrich-only semantics, and
 * externalId stamping that the single-create services don't model. Org-binding
 * and the one-writer CrmActivity rule still apply in full.
 *
 * EVERY row lands in the report: created / updated / enriched / kept-local /
 * error. dryRun runs the exact same decisions with the writes skipped — what
 * the dialog shows before the operator confirms IS what the write run does.
 */
import { Prisma, type CrmDealStatus, type CrmDealPipeline } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { parseCSV } from "@/lib/csv-parser";
import { recordCrmActivityBulk, type CrmActivityEntry } from "@/crm/lib/crm-activity";
import { CRM_OWNER_ROLES } from "@/crm/lib/crm-roles";
import { companyNameKey } from "@/crm/services/company-service";
import { contactEmailKey, normalizeContactTags } from "@/crm/services/crm-contact-service";
import {
  FRESHSALES_SOURCE,
  COMPANY_FIELDS,
  CONTACT_FIELDS,
  DEAL_FIELDS,
  resolveColumns,
  mapCompanyRow,
  mapContactRow,
  mapDealRow,
  dealOutcomeFromStageName,
  matchEventByName,
  decideImportAction,
  formatDateEcho,
  CSV_DATE_FORMAT_LABELS,
  type CsvDateFormat,
} from "@/crm/lib/freshsales-import";

export interface ImportRowError {
  row: number; // 1-based data-row number (header excluded)
  error: string;
}

export interface ImportReport {
  ok: true;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  enriched: number;
  keptLocal: number;
  errors: ImportRowError[];
  /** CSV headers nothing claimed — a dropped column must never be silent. */
  unrecognizedColumns: string[];
  /** Extra, per-type mapping notes for the confirm screen (deals fill these). */
  notes: string[];
}

export type ImportResult = ImportReport | { ok: false; code: string; message: string };

interface ImportCtx {
  organizationId: string;
  userId: string | null;
  csvText: string;
  dryRun: boolean;
}

/**
 * Index prefetched rows by a key, skipping rows whose key is null.
 *
 * WHY PREFETCH AT ALL. Every row used to cost TWO reads (by externalId, then by
 * natural key) before its write — 15,000 round trips for a 5,000-row file, all
 * sequential, which is what put a large import past the 60s gateway timeout and
 * left it half-written. One `findMany` up front collapses those to zero.
 *
 * SAFE BECAUSE THE FILE IS DEDUPED FIRST: a prefetched map goes stale only if a
 * row created earlier in the SAME file needs to be seen by a later row, and the
 * `seenKeys` guard already rejects a second row carrying either identity. Rows
 * created by a CONCURRENT import are still caught — the unique indexes hold and
 * the P2002 handler reports "re-run to converge".
 *
 * Writes stay per-row on purpose: `createMany` would be faster still but would
 * lose the per-row try/catch, and one bad row killing a 5,000-row file is a far
 * worse trade than a slower import.
 */
function indexBy<T>(rows: T[], key: (row: T) => string | null | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    if (k) map.set(k, row);
  }
  return map;
}

function parseOrFail(csvText: string): { headers: string[]; rows: string[][] } | { ok: false; code: string; message: string } {
  const parsed = parseCSV(csvText);
  if (parsed.error) return { ok: false, code: "CSV_INVALID", message: parsed.error };
  return parsed;
}

/** Fill only the BLANK fields of an existing row — never overwrite a human's data. */
function enrichPatch<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<Record<keyof T, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === "") continue;
    const cur = existing[k as keyof T];
    if (cur === null || cur === undefined || cur === "") patch[k] = v;
  }
  return patch;
}

// ── Companies ─────────────────────────────────────────────────────────────────

export async function importFreshsalesCompanies(ctx: ImportCtx): Promise<ImportResult> {
  const parsed = parseOrFail(ctx.csvText);
  if ("ok" in parsed) return parsed;

  const cols = resolveColumns(parsed.headers, COMPANY_FIELDS);
  if (cols.missingRequired.length > 0) {
    apiLogger.warn({ msg: "crm-import:companies-missing-columns", organizationId: ctx.organizationId, missing: cols.missingRequired });
    return { ok: false, code: "MISSING_COLUMNS", message: `CSV is missing required column(s): ${cols.missingRequired.join(", ")}` };
  }

  const report: ImportReport = {
    ok: true, dryRun: ctx.dryRun, total: parsed.rows.length,
    created: 0, updated: 0, enriched: 0, keptLocal: 0,
    errors: [], unrecognizedColumns: cols.unrecognized, notes: [],
  };
  const activity: CrmActivityEntry[] = [];
  const seenKeys = new Set<string>(); // duplicate rows within ONE file

  // Prefetch every candidate match in one query instead of two reads per row.
  const wanted = parsed.rows.map((r) => {
    const m = mapCompanyRow(r, cols);
    return "row" in m ? m.row : null;
  });
  const existingCompanies = await db.crmCompany.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: [
        { externalSource: FRESHSALES_SOURCE, externalId: { in: wanted.map((w) => w?.externalId).filter((v): v is string => !!v) } },
        { nameKey: { in: wanted.map((w) => (w ? companyNameKey(w.name) : null)).filter((v): v is string => !!v) } },
      ],
    },
  });
  const byExternalId = indexBy(existingCompanies, (c) => (c.externalSource === FRESHSALES_SOURCE ? c.externalId : null));
  const byNameKey = indexBy(existingCompanies, (c) => c.nameKey);

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNo = i + 1;
    try {
      const mapped = mapCompanyRow(parsed.rows[i]!, cols);
      if ("error" in mapped) {
        report.errors.push({ row: rowNo, error: mapped.error });
        continue;
      }
      const row = mapped.row;
      const nameKey = companyNameKey(row.name);
      // In-file dedup tracks BOTH identities (R2-M8): keying on externalId-when-
      // present let two rows with different ids but the same normalized name both
      // pass — and then dry-run said "2 created" while the write did "1 created,
      // 1 updated" (row 1's write made row 2's lookup hit). Namespaced so an id
      // can never collide with a name key.
      const dupKeys = [row.externalId ? `id:${row.externalId}` : null, `key:${nameKey}`].filter((k): k is string => k !== null);
      if (dupKeys.some((k) => seenKeys.has(k))) {
        report.errors.push({ row: rowNo, error: `Duplicate of an earlier row in this file (${row.name})` });
        continue;
      }
      dupKeys.forEach((k) => seenKeys.add(k));

      // Match: the source id first (previously imported), else the normalized
      // name (converges with hand-typed accounts, which then get the id stamped).
      const existing =
        (row.externalId ? byExternalId.get(row.externalId) : undefined) ?? byNameKey.get(nameKey) ?? null;

      const action = decideImportAction(existing);
      // R2-H1: the enrich path deliberately does NOT stamp lastImportedAt — an
      // EA-born row stays enrich-FOREVER. Stamping it here made the SECOND
      // import of the same export take the Freshsales-wins `update` path and
      // overwrite (or NULL) the very human-typed fields the first import's
      // enrich preserved. The externalId is still stamped so later imports
      // match by id; decideImportAction keeps returning "enrich" for the row.
      const stamp = {
        externalSource: FRESHSALES_SOURCE,
        externalId: row.externalId ?? existing?.externalId ?? null,
        ...(action === "enrich" ? {} : { lastImportedAt: new Date() }),
      };

      if (action === "create") {
        report.created++;
        if (!ctx.dryRun) {
          const created = await db.crmCompany.create({
            data: {
              organizationId: ctx.organizationId,
              name: row.name,
              nameKey,
              website: row.website ?? null,
              industry: row.industry ?? null,
              city: row.city ?? null,
              country: row.country ?? null,
              phone: row.phone ?? null,
              ...(row.tags ? { tags: normalizeContactTags(row.tags) } : {}),
              notes: row.notes ?? null,
              ...stamp,
            },
          });
          activity.push({
            organizationId: ctx.organizationId, entityType: "COMPANY", entityId: created.id,
            action: "IMPORTED", actorId: ctx.userId, changes: { source: FRESHSALES_SOURCE, name: row.name },
          });
        }
      } else if (action === "skip-kept-local") {
        report.keptLocal++;
      } else {
        // enrich (EA-born row) or update (previously imported, untouched since)
        const data =
          action === "enrich"
            ? {
                ...enrichPatch(existing!, {
                  website: row.website, industry: row.industry, city: row.city,
                  country: row.country, phone: row.phone, notes: row.notes,
                }),
                // Tags are an array, so enrichPatch's blank-scalar rule can't see
                // them: fill only when the EA row has none (the contacts pattern).
                ...(row.tags && (existing!.tags?.length ?? 0) === 0
                  ? { tags: normalizeContactTags(row.tags) }
                  : {}),
              }
            : {
                // Freshsales wins on the imported fields. The display name follows
                // the CSV; nameKey must follow the name (the contacts-H2 lesson).
                name: row.name, nameKey,
                website: row.website ?? null, industry: row.industry ?? null,
                city: row.city ?? null, country: row.country ?? null,
                phone: row.phone ?? null, notes: row.notes ?? null,
                ...(row.tags ? { tags: normalizeContactTags(row.tags) } : {}),
              };
        if (action === "enrich") report.enriched++;
        else report.updated++;
        if (!ctx.dryRun) {
          await db.crmCompany.update({ where: { id: existing!.id }, data: { ...data, ...stamp } });
          activity.push({
            organizationId: ctx.organizationId, entityType: "COMPANY", entityId: existing!.id,
            action: "IMPORTED", actorId: ctx.userId,
            changes: { source: FRESHSALES_SOURCE, mode: action, name: row.name },
          });
        }
      }
    } catch (err) {
      // A rename collision (two Freshsales accounts normalizing to one name) or
      // any per-row surprise stays a per-row error — one bad row never kills a file.
      const msg =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
          ? "A company with this name already exists (a duplicate row in this file, or a concurrent import) — re-run to converge"
          : "Row failed — see server logs";
      apiLogger.error({
        msg: "crm-import:company-row-failed", organizationId: ctx.organizationId, row: rowNo,
        err: err instanceof Error ? err.message : String(err),
      });
      report.errors.push({ row: rowNo, error: msg });
    }
  }

  if (!ctx.dryRun) void recordCrmActivityBulk(activity);
  apiLogger.info({
    msg: "crm-import:companies-done", organizationId: ctx.organizationId, dryRun: ctx.dryRun,
    total: report.total, created: report.created, updated: report.updated,
    enriched: report.enriched, keptLocal: report.keptLocal, errorCount: report.errors.length,
  });
  return report;
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export async function importFreshsalesContacts(ctx: ImportCtx): Promise<ImportResult> {
  const parsed = parseOrFail(ctx.csvText);
  if ("ok" in parsed) return parsed;

  const cols = resolveColumns(parsed.headers, CONTACT_FIELDS);
  if (cols.missingRequired.length > 0) {
    apiLogger.warn({ msg: "crm-import:contacts-missing-columns", organizationId: ctx.organizationId, missing: cols.missingRequired });
    return { ok: false, code: "MISSING_COLUMNS", message: `CSV is missing required column(s): ${cols.missingRequired.join(", ")}` };
  }

  const report: ImportReport = {
    ok: true, dryRun: ctx.dryRun, total: parsed.rows.length,
    created: 0, updated: 0, enriched: 0, keptLocal: 0,
    errors: [], unrecognizedColumns: cols.unrecognized, notes: [],
  };
  const activity: CrmActivityEntry[] = [];
  const seenKeys = new Set<string>();

  const [resolveCompany, resolveOwner] = await Promise.all([
    makeCompanyResolver(ctx),
    makeOwnerResolver(ctx.organizationId),
  ]);
  /** Lifecycle/status labels we couldn't map — reported, never coerced to a default. */
  const unmappedEnums = new Set<string>();

  // One prefetch instead of two reads per row — see indexBy().
  const wanted = parsed.rows.map((r) => {
    const m = mapContactRow(r, cols);
    return "row" in m ? m.row : null;
  });
  const existingContacts = await db.crmContact.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: [
        { externalSource: FRESHSALES_SOURCE, externalId: { in: wanted.map((w) => w?.externalId).filter((v): v is string => !!v) } },
        { emailKey: { in: wanted.map((w) => (w ? contactEmailKey(w.email) : null)).filter((v): v is string => !!v) } },
      ],
    },
  });
  const byExternalId = indexBy(existingContacts, (c) => (c.externalSource === FRESHSALES_SOURCE ? c.externalId : null));
  const byEmailKey = indexBy(existingContacts, (c) => c.emailKey);

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNo = i + 1;
    try {
      const mapped = mapContactRow(parsed.rows[i]!, cols);
      if ("error" in mapped) {
        report.errors.push({ row: rowNo, error: mapped.error });
        continue;
      }
      const row = mapped.row;
      const emailKey = contactEmailKey(row.email);
      // Both identities tracked — see the companies loop (R2-M8).
      const dupKeys = [row.externalId ? `id:${row.externalId}` : null, `key:${emailKey}`].filter((k): k is string => k !== null);
      if (dupKeys.some((k) => seenKeys.has(k))) {
        report.errors.push({ row: rowNo, error: `Duplicate of an earlier row in this file (${row.email})` });
        continue;
      }
      dupKeys.forEach((k) => seenKeys.add(k));

      const existing =
        (row.externalId ? byExternalId.get(row.externalId) : undefined) ?? byEmailKey.get(emailKey) ?? null;

      const action = decideImportAction(existing);
      // R2-H1: the enrich path deliberately does NOT stamp lastImportedAt — an
      // EA-born row stays enrich-FOREVER. Stamping it here made the SECOND
      // import of the same export take the Freshsales-wins `update` path and
      // overwrite (or NULL) the very human-typed fields the first import's
      // enrich preserved. The externalId is still stamped so later imports
      // match by id; decideImportAction keeps returning "enrich" for the row.
      const stamp = {
        externalSource: FRESHSALES_SOURCE,
        externalId: row.externalId ?? existing?.externalId ?? null,
        ...(action === "enrich" ? {} : { lastImportedAt: new Date() }),
      };
      const companyId = await resolveCompany.idFor(row.companyName);
      const dryCompany = typeof companyId === "string" && companyId.startsWith("dry:");
      const ownerId = resolveOwner.resolve(row.ownerEmail, row.ownerName);
      row.unmappedEnums.forEach((e) => unmappedEnums.add(e));

      if (action === "create") {
        report.created++;
        if (!ctx.dryRun) {
          const created = await db.crmContact.create({
            data: {
              organizationId: ctx.organizationId,
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              emailKey,
              jobTitle: row.jobTitle ?? null,
              phone: row.phone ?? null,
              mobile: row.mobile ?? null,
              country: row.country ?? null,
              ...(row.tags ? { tags: normalizeContactTags(row.tags) } : {}),
              ownerId,
              lifecycleStage: row.lifecycleStage ?? null,
              status: row.status ?? null,
              companyId: dryCompany ? null : companyId,
              ...stamp,
            },
          });
          activity.push({
            organizationId: ctx.organizationId, entityType: "CONTACT", entityId: created.id,
            action: "IMPORTED", actorId: ctx.userId, changes: { source: FRESHSALES_SOURCE, email: row.email },
          });
        }
      } else if (action === "skip-kept-local") {
        report.keptLocal++;
      } else {
        // Tags don't fit enrichPatch's blank-scalar rule (an array is never
        // null): enrich fills them only when the EA row has none; a
        // Freshsales-wins update takes the CSV's list when the column is there.
        const tagPatch =
          row.tags && (action === "update" || (existing!.tags?.length ?? 0) === 0)
            ? { tags: normalizeContactTags(row.tags) }
            : {};
        const data =
          action === "enrich"
            ? {
                ...enrichPatch(existing!, {
                  jobTitle: row.jobTitle, phone: row.phone, mobile: row.mobile, country: row.country,
                  // Owner + ladders are enrich-only here for the same reason as
                  // every other field: an EA-born contact a human has already
                  // assigned must not be re-pointed by a stale CSV.
                  ownerId: ownerId ?? undefined,
                  lifecycleStage: row.lifecycleStage, status: row.status,
                  companyId: dryCompany ? undefined : companyId ?? undefined,
                }),
                ...tagPatch,
              }
            : {
                firstName: row.firstName, lastName: row.lastName,
                jobTitle: row.jobTitle ?? null, phone: row.phone ?? null,
                mobile: row.mobile ?? null, country: row.country ?? null,
                // Freshsales wins on update — but an UNMATCHABLE owner must not
                // silently un-own a live contact (the deals-path rule, mirrored).
                ...(ownerId ? { ownerId } : {}),
                ...(row.lifecycleStage ? { lifecycleStage: row.lifecycleStage } : {}),
                ...(row.status ? { status: row.status } : {}),
                ...tagPatch,
                ...(dryCompany ? {} : { companyId }),
              };
        if (action === "enrich") report.enriched++;
        else report.updated++;
        if (!ctx.dryRun) {
          await db.crmContact.update({ where: { id: existing!.id }, data: { ...data, ...stamp } });
          activity.push({
            organizationId: ctx.organizationId, entityType: "CONTACT", entityId: existing!.id,
            action: "IMPORTED", actorId: ctx.userId,
            changes: { source: FRESHSALES_SOURCE, mode: action, email: row.email },
          });
        }
      }
    } catch (err) {
      // A P2002 here is a duplicate email/externalId in this file OR a concurrent
      // import of the same export (the find-then-create both saw null) — no row
      // is duplicated (the unique index holds); re-running converges via update.
      const dup = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      apiLogger.error({
        msg: "crm-import:contact-row-failed", organizationId: ctx.organizationId, row: rowNo,
        err: err instanceof Error ? err.message : String(err),
      });
      report.errors.push({
        row: rowNo,
        error: dup
          ? "A contact with this email or id already exists (a duplicate in this file, or a concurrent import) — re-run to converge"
          : "Row failed — see server logs",
      });
    }
  }

  if (resolveCompany.created > 0) {
    report.notes.push(`${resolveCompany.created} compan${resolveCompany.created === 1 ? "y" : "ies"} named in the CSV didn't exist and ${ctx.dryRun ? "would be" : "were"} created`);
  }
  report.notes.push(...ownerNotes(resolveOwner));
  if (unmappedEnums.size > 0) {
    report.notes.push(
      `Left blank — no matching value in EA-SYS for: ${[...unmappedEnums].join(", ")}`,
    );
  }
  if (!ctx.dryRun) void recordCrmActivityBulk(activity);
  apiLogger.info({
    msg: "crm-import:contacts-done", organizationId: ctx.organizationId, dryRun: ctx.dryRun,
    total: report.total, created: report.created, updated: report.updated,
    enriched: report.enriched, keptLocal: report.keptLocal, errorCount: report.errors.length,
    companiesCreated: resolveCompany.created,
    ownersUnmatched: resolveOwner.unmatched,
    ownersByName: resolveOwner.matchedByName,
    ownersAmbiguous: resolveOwner.ambiguous,
    unmappedEnumCount: unmappedEnums.size,
  });
  return report;
}

// ── Shared: CSV company-name → CrmCompany id (find-or-create) ────────────────

/**
 * Companies named in a contacts/deals CSV but absent from the org are created
 * on the fly (import order shouldn't be brittle). One prefetched nameKey map,
 * shared by both importers — the cross-caller-duplication rule.
 */
async function makeCompanyResolver(ctx: ImportCtx) {
  const companies = await db.crmCompany.findMany({
    where: { organizationId: ctx.organizationId },
    select: { id: true, nameKey: true },
  });
  const byKey = new Map(companies.map((c) => [c.nameKey, c.id]));
  const resolver = {
    created: 0,
    async idFor(name: string | undefined): Promise<string | null> {
      if (!name?.trim()) return null;
      const key = companyNameKey(name);
      if (!key) return null;
      const hit = byKey.get(key);
      if (hit) return hit;
      if (ctx.dryRun) {
        // Count it, remember it, don't write it.
        byKey.set(key, `dry:${key}`);
        resolver.created++;
        return `dry:${key}`;
      }
      try {
        const created = await db.crmCompany.create({
          data: { organizationId: ctx.organizationId, name: name.trim(), nameKey: key, externalSource: FRESHSALES_SOURCE, lastImportedAt: new Date() },
        });
        byKey.set(key, created.id);
        resolver.created++;
        return created.id;
      } catch (err) {
        // R2-M4: the map was prefetched once, so a company created concurrently
        // (in the UI, or by an overlapping import) P2002s here. The loser must
        // REUSE the winner — as a bare throw it became a per-row error and the
        // contact/deal row was not imported. Same pattern as findOrCreateCompany.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const winner = await db.crmCompany.findUnique({
            where: { organizationId_nameKey: { organizationId: ctx.organizationId, nameKey: key } },
            select: { id: true },
          });
          if (winner) {
            apiLogger.info({ msg: "crm-import:company-resolver-race-reused", organizationId: ctx.organizationId, companyId: winner.id });
            byKey.set(key, winner.id);
            return winner.id;
          }
        }
        throw err;
      }
    },
  };
  return resolver;
}

// ── Shared: CSV owner (email, else name) → User id ───────────────────────────

/**
 * Resolve a CSV's owner column onto a team member. ONE resolver for deals AND
 * contacts (the cross-caller-duplication rule) — contacts previously imported
 * with no owner at all, and deals matched on email only.
 *
 * Order: email wins (exact, unambiguous). Falling back to NAME matters because a
 * Freshsales list view renders "Sales Owner" as a display name and may not offer
 * an email column at all — without this every imported deal lands unassigned.
 *
 * An AMBIGUOUS name (two team members called "John Smith") assigns NOBODY and is
 * counted separately. Picking the first would silently hand one rep's whole book
 * to another, and unlike a blank owner that is not visibly wrong.
 *
 * Role-bound (review R2-M5): only CRM_OWNER_ROLES are candidates, so a CSV owner
 * matching a MEMBER/ONSITE account counts as unmatched rather than assigning CRM
 * content to a role the CRM excludes.
 */
async function makeOwnerResolver(organizationId: string) {
  const users = await db.user.findMany({
    where: { organizationId, role: { in: [...CRM_OWNER_ROLES] } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const byName = new Map<string, string[]>();
  for (const u of users) {
    const full = `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
    if (!full) continue;
    byName.set(full, [...(byName.get(full) ?? []), u.id]);
  }

  return {
    unmatched: 0,
    ambiguous: 0,
    matchedByName: 0,
    resolve(email: string | undefined, name: string | undefined): string | null {
      if (email) {
        const hit = byEmail.get(email.trim().toLowerCase());
        if (hit) return hit;
      }
      if (name) {
        const candidates = byName.get(name.trim().toLowerCase().replace(/\s+/g, " ")) ?? [];
        if (candidates.length === 1) {
          this.matchedByName++;
          return candidates[0]!;
        }
        if (candidates.length > 1) {
          this.ambiguous++;
          return null;
        }
      }
      if (email || name) this.unmatched++;
      return null;
    },
  };
}

/** The owner notes both importers append, built in one place so they can't drift. */
function ownerNotes(r: { unmatched: number; ambiguous: number; matchedByName: number }): string[] {
  const notes: string[] = [];
  if (r.matchedByName > 0) notes.push(`${r.matchedByName} owner(s) matched by NAME (no email column) — spot-check those`);
  if (r.ambiguous > 0) notes.push(`${r.ambiguous} owner name(s) matched more than one team member — left unassigned rather than guessed`);
  if (r.unmatched > 0) notes.push(`${r.unmatched} record(s) had an owner we couldn't match to a CRM team member — left unassigned`);
  return notes;
}

// ── Deals ─────────────────────────────────────────────────────────────────────

export interface ImportDealsCtx extends ImportCtx {
  /** Where deals whose name matches no event land — a deal must have an event. */
  fallbackEventId: string;
  /** Used when the CSV has no currency column (Freshsales often omits it). */
  defaultCurrency?: string;
  /**
   * DECLARED by the operator in the dialog — never guessed. `05/03/2026` is
   * 5 March or 3 May depending on the export's locale, and the dry-run report
   * echoes the first parsed date back so a wrong pick is caught before writing.
   */
  dateFormat: CsvDateFormat;
  /**
   * OUR classification (corporate vs conference sales), applied to every row.
   * Deliberately not read from a CSV column: `CrmDealPipeline` is a two-value
   * enum of our own and a Freshsales pipeline NAME can't be mapped onto it
   * without a translation table nobody has. Undefined leaves it null.
   */
  pipeline?: CrmDealPipeline;
}

export async function importFreshsalesDeals(ctx: ImportDealsCtx): Promise<ImportResult> {
  const parsed = parseOrFail(ctx.csvText);
  if ("ok" in parsed) return parsed;

  const cols = resolveColumns(parsed.headers, DEAL_FIELDS);
  // The Id column is REQUIRED for deals: it is the upsert key that makes
  // re-importing a fresh export converge — without it every re-run would
  // duplicate the whole pipeline.
  const missing = [...cols.missingRequired, ...(cols.index.externalId < 0 ? ["id" as const] : [])];
  if (missing.length > 0) {
    apiLogger.warn({ msg: "crm-import:deals-missing-columns", organizationId: ctx.organizationId, missing });
    return { ok: false, code: "MISSING_COLUMNS", message: `CSV is missing required column(s): ${missing.join(", ")}` };
  }

  // Everything the rows resolve against, fetched once and org-bound.
  const [fallbackEvent, events, stages, resolveOwner, dealTypes] = await Promise.all([
    db.event.findFirst({ where: { id: ctx.fallbackEventId, organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    db.event.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    db.crmPipelineStage.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    makeOwnerResolver(ctx.organizationId),
    db.crmDealType.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
  ]);
  if (!fallbackEvent) {
    apiLogger.warn({ msg: "crm-import:deals-bad-fallback-event", organizationId: ctx.organizationId, fallbackEventId: ctx.fallbackEventId });
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Fallback event not found" };
  }
  const dealTypeByName = new Map(dealTypes.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const stageByName = new Map(stages.map((st) => [st.name.trim().toLowerCase(), st]));
  const wonStage = stages.find((st) => st.terminalOutcome === "WON");
  const lostStage = stages.find((st) => st.terminalOutcome === "LOST");
  if (stages.length === 0) {
    return { ok: false, code: "STAGE_NOT_FOUND", message: "The pipeline has no stages — open the deals board once to seed it" };
  }
  // NO fallback into a terminal column (R2 rider L14): on a hand-built pipeline
  // with only terminal stages, `?? stages[0]` seated OPEN deals in a Won/Lost
  // column — exactly the stage/status divergence the row loop refuses below.
  const firstOpenStage = stages.find((st) => !st.isTerminal);
  if (!firstOpenStage) {
    apiLogger.warn({ msg: "crm-import:deals-no-open-stage", organizationId: ctx.organizationId });
    return { ok: false, code: "STAGE_NOT_FOUND", message: "The pipeline has no open (non-terminal) column — add one in Manage stages before importing deals" };
  }

  const report: ImportReport = {
    ok: true, dryRun: ctx.dryRun, total: parsed.rows.length,
    created: 0, updated: 0, enriched: 0, keptLocal: 0,
    errors: [], unrecognizedColumns: cols.unrecognized, notes: [],
  };
  const activity: CrmActivityEntry[] = [];
  const resolveCompany = await makeCompanyResolver(ctx);
  const seenIds = new Set<string>();

  // One prefetch instead of a read per row — see indexBy().
  const wantedIds = parsed.rows
    .map((r) => {
      const m = mapDealRow(r, cols, ctx.dateFormat);
      return "row" in m ? m.row.externalId : null;
    })
    .filter((v): v is string => !!v);
  const existingDeals = wantedIds.length
    ? await db.crmDeal.findMany({
        where: { organizationId: ctx.organizationId, externalSource: FRESHSALES_SOURCE, externalId: { in: wantedIds } },
      })
    : [];
  const dealByExternalId = indexBy(existingDeals, (d) => d.externalId);
  const stageMappingNotes = new Map<string, string>();
  let eventMatched = 0;
  let eventFallback = 0;
  const unmappedDealTypes = new Set<string>();
  /** First real date seen, echoed in the report so a wrong format pick is visible. */
  let dateEcho: string | null = null;
  /** Won/Lost rows carrying no close date — their wonAt/lostAt stays NULL, reported. */
  let closedWithoutDate = 0;

  const defaultCurrency = (ctx.defaultCurrency ?? "USD").toUpperCase();

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNo = i + 1;
    try {
      const mapped = mapDealRow(parsed.rows[i]!, cols, ctx.dateFormat);
      if ("error" in mapped) {
        report.errors.push({ row: rowNo, error: mapped.error });
        continue;
      }
      const row = mapped.row;

      // Echo the FIRST real date back to the operator. A wrong format pick is
      // otherwise invisible until months of win history are already wrong: both
      // orders parse cleanly for days 1-12, so counts alone can't reveal it.
      if (!dateEcho) {
        for (const field of ["expectedClose", "closedDate"] as const) {
          const parsedDate = row[field];
          const rawCell = parsed.rows[i]![cols.index[field]]?.trim();
          if (parsedDate && rawCell) {
            dateEcho = formatDateEcho(rawCell, parsedDate);
            break;
          }
        }
      }
      if (!row.externalId) {
        report.errors.push({ row: rowNo, error: "Missing deal Id" });
        continue;
      }
      if (seenIds.has(row.externalId)) {
        report.errors.push({ row: rowNo, error: `Duplicate of an earlier row in this file (${row.name})` });
        continue;
      }
      seenIds.add(row.externalId);

      // ── Stage + outcome ── outcome ("Closed won") comes from the stage name;
      // open stages map by name onto OUR pipeline, unmatched → the first open
      // stage — every non-exact mapping is reported before anyone confirms.
      const outcome = dealOutcomeFromStageName(row.stageName);
      let stage;
      if (outcome === "WON") stage = wonStage;
      else if (outcome === "LOST") stage = lostStage;
      else if (row.stageName) {
        stage = stageByName.get(row.stageName.trim().toLowerCase());
        if (!stage) {
          stage = firstOpenStage;
          stageMappingNotes.set(row.stageName, `Stage "${row.stageName}" → "${firstOpenStage.name}" (no matching column)`);
        }
      } else {
        stage = firstOpenStage;
      }
      if (!stage) {
        // A won/lost deal with no outcome-mapped column would be a stage/status
        // divergence (review H3) — refuse the row, never mint fiction.
        report.errors.push({ row: rowNo, error: `The pipeline has no ${outcome} column — map one in Manage stages first` });
        continue;
      }

      // ── Event ── name-match, else the operator-chosen fallback.
      const matchedEvent = matchEventByName(row.name, events);
      const eventId = matchedEvent?.id ?? fallbackEvent.id;
      if (matchedEvent) eventMatched++;
      else eventFallback++;

      // ── Owner ── email first, then an unambiguous name match.
      const ownerId = resolveOwner.resolve(row.ownerEmail, row.ownerName);

      // ── Deal type ── matched by name against the org's own types; an unknown
      // type leaves the deal untyped and is reported, never invented.
      let dealTypeId: string | null = null;
      if (row.dealTypeName) {
        dealTypeId = dealTypeByName.get(row.dealTypeName.trim().toLowerCase()) ?? null;
        if (!dealTypeId) unmappedDealTypes.add(row.dealTypeName);
      }

      const companyId = await resolveCompany.idFor(row.companyName);
      const dryCompany = typeof companyId === "string" && companyId.startsWith("dry:");

      const existing = dealByExternalId.get(row.externalId) ?? null;
      // Deals match by externalId only (an EA-born deal has none), so "enrich"
      // is unreachable here — decideImportAction still guards kept-local.
      const action = decideImportAction(existing);

      const status: CrmDealStatus = outcome ?? "OPEN";
      // NO `?? new Date()` HERE. A won deal imported without a close date used
      // to be stamped with the IMPORT date, which reads as "won today" and makes
      // every won-in-a-period report wrong. An unknown close date is NULL and
      // reported: the deal correctly drops out of date-ranged reports rather
      // than landing in the wrong bucket. (A cell that is present but
      // unreadable never reaches here — mapDealRow made it a row error.)
      if (outcome && !row.closedDate) closedWithoutDate++;
      const closeStamps =
        outcome === "WON"
          ? { wonAt: row.closedDate ?? null, lostAt: null, lostReason: null }
          : outcome === "LOST"
            ? { lostAt: row.closedDate ?? null, wonAt: null, lostReason: row.lostReason ?? null }
            : { wonAt: null, lostAt: null, lostReason: null };
      // R2-M6: on a RE-IMPORT of a deal whose closed status hasn't changed and
      // whose CSV carries no Closed-date value, PRESERVE the stored stamps —
      // the `?? new Date()` fallback otherwise drifted every won deal's wonAt
      // to the re-import date, and "deals won in July" reported zero. The
      // fallback is only for a genuine transition with no date (best available).
      const closeStampsForUpdate =
        !row.closedDate && existing !== null && existing.status === status ? {} : closeStamps;

      const common = {
        name: row.name,
        stageId: stage.id,
        status,
        dealValue: row.amount !== undefined ? new Prisma.Decimal(row.amount) : null,
        currency: row.currency ?? defaultCurrency,
        expectedClose: row.expectedClose ?? null,
        ownerId,
        dealTypeId,
        ...(row.tags ? { tags: normalizeContactTags(row.tags) } : {}),
        // The pipeline is OUR classification (corporate vs conference), not a
        // Freshsales column — a Freshsales pipeline NAME can't be coerced onto a
        // two-value enum without inventing a mapping, so the operator picks one
        // for the whole file instead.
        ...(ctx.pipeline ? { pipeline: ctx.pipeline } : {}),
        ...(dryCompany ? {} : { companyId }),
        externalSource: FRESHSALES_SOURCE,
        externalId: row.externalId,
        lastImportedAt: new Date(),
      };

      if (action === "create") {
        report.created++;
        if (!ctx.dryRun) {
          const created = await db.crmDeal.create({
            data: { organizationId: ctx.organizationId, eventId, ...common, ...closeStamps },
          });
          activity.push({
            organizationId: ctx.organizationId, entityType: "DEAL", entityId: created.id,
            action: "IMPORTED", actorId: ctx.userId,
            changes: { source: FRESHSALES_SOURCE, name: row.name, status, stage: stage.name },
          });
        }
      } else if (action === "skip-kept-local") {
        report.keptLocal++;
      } else {
        report.updated++;
        if (!ctx.dryRun) {
          // Freshsales wins on the imported fields. The EVENT is deliberately
          // NOT re-pointed on update: a human may have re-pointed it in EA-SYS,
          // and the CSV knows nothing about our events anyway. Close stamps are
          // the R2-M6 preserving variant — see closeStampsForUpdate above.
          // OWNER: preserve the existing owner when the CSV owner is
          // UNMATCHABLE (e.g. the rep's role changed to a non-CRM role since the
          // last import, so `ownerByEmail` no longer resolves them) — a mapping
          // failure must not silently un-own a live deal (CRM review LOW). A
          // matchable CSV owner still wins; only a null (unresolved) is skipped.
          await db.crmDeal.update({
            where: { id: existing!.id },
            data: { ...common, ownerId: ownerId ?? existing!.ownerId, ...closeStampsForUpdate },
          });
          activity.push({
            organizationId: ctx.organizationId, entityType: "DEAL", entityId: existing!.id,
            action: "IMPORTED", actorId: ctx.userId,
            changes: { source: FRESHSALES_SOURCE, mode: "update", name: row.name, status, stage: stage.name },
          });
        }
      }
    } catch (err) {
      // A P2002 here is a duplicate externalId in this file OR a concurrent
      // import of the same export — no duplicate row is created (the unique
      // index holds); re-running converges via the update path.
      const dup = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      apiLogger.error({
        msg: "crm-import:deal-row-failed", organizationId: ctx.organizationId, row: rowNo,
        err: err instanceof Error ? err.message : String(err),
      });
      report.errors.push({
        row: rowNo,
        error: dup
          ? "A deal with this id already exists (a duplicate in this file, or a concurrent import) — re-run to converge"
          : "Row failed — see server logs",
      });
    }
  }

  // Dates first — it is the note most likely to stop a bad import.
  report.notes.push(
    dateEcho
      ? `Dates read as ${CSV_DATE_FORMAT_LABELS[ctx.dateFormat]} — e.g. ${dateEcho}. Wrong? Change the date format and preview again.`
      : `Dates read as ${CSV_DATE_FORMAT_LABELS[ctx.dateFormat]} (no dated row in this file to show)`,
  );
  if (closedWithoutDate > 0) {
    report.notes.push(
      `${closedWithoutDate} won/lost deal(s) had no close date — their won/lost date is left empty rather than stamped with today, so they won't appear in date-ranged reports`,
    );
  }
  report.notes.push(`Events: ${eventMatched} matched by name, ${eventFallback} → fallback "${fallbackEvent.name}"`);
  for (const note of stageMappingNotes.values()) report.notes.push(note);
  report.notes.push(...ownerNotes(resolveOwner));
  if (unmappedDealTypes.size > 0) {
    report.notes.push(
      `Deal type(s) not found in this org, left untyped: ${[...unmappedDealTypes].join(", ")} — add them under Manage deal types and re-import to fill them in`,
    );
  }
  if (resolveCompany.created > 0) {
    report.notes.push(`${resolveCompany.created} compan${resolveCompany.created === 1 ? "y" : "ies"} named in the CSV didn't exist and ${ctx.dryRun ? "would be" : "were"} created`);
  }

  if (!ctx.dryRun) void recordCrmActivityBulk(activity);
  apiLogger.info({
    msg: "crm-import:deals-done", organizationId: ctx.organizationId, dryRun: ctx.dryRun,
    total: report.total, created: report.created, updated: report.updated,
    keptLocal: report.keptLocal, errorCount: report.errors.length,
    eventMatched, eventFallback,
    ownersUnmatched: resolveOwner.unmatched,
    ownersByName: resolveOwner.matchedByName,
    ownersAmbiguous: resolveOwner.ambiguous,
    closedWithoutDate,
  });
  return report;
}
