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
import { Prisma, type CrmDealStatus } from "@prisma/client";
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
        (row.externalId
          ? await db.crmCompany.findFirst({
              where: { organizationId: ctx.organizationId, externalSource: FRESHSALES_SOURCE, externalId: row.externalId },
            })
          : null) ??
        (await db.crmCompany.findUnique({
          where: { organizationId_nameKey: { organizationId: ctx.organizationId, nameKey } },
        }));

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
            ? enrichPatch(existing!, {
                website: row.website, industry: row.industry, city: row.city,
                country: row.country, notes: row.notes,
              })
            : {
                // Freshsales wins on the imported fields. The display name follows
                // the CSV; nameKey must follow the name (the contacts-H2 lesson).
                name: row.name, nameKey,
                website: row.website ?? null, industry: row.industry ?? null,
                city: row.city ?? null, country: row.country ?? null, notes: row.notes ?? null,
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
          ? "Another company already uses this name"
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

  const resolveCompany = await makeCompanyResolver(ctx);

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
        (row.externalId
          ? await db.crmContact.findFirst({
              where: { organizationId: ctx.organizationId, externalSource: FRESHSALES_SOURCE, externalId: row.externalId },
            })
          : null) ??
        (await db.crmContact.findUnique({
          where: { organizationId_emailKey: { organizationId: ctx.organizationId, emailKey } },
        }));

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
                  companyId: dryCompany ? undefined : companyId ?? undefined,
                }),
                ...tagPatch,
              }
            : {
                firstName: row.firstName, lastName: row.lastName,
                jobTitle: row.jobTitle ?? null, phone: row.phone ?? null,
                mobile: row.mobile ?? null, country: row.country ?? null,
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
      apiLogger.error({
        msg: "crm-import:contact-row-failed", organizationId: ctx.organizationId, row: rowNo,
        err: err instanceof Error ? err.message : String(err),
      });
      report.errors.push({ row: rowNo, error: "Row failed — see server logs" });
    }
  }

  if (resolveCompany.created > 0) {
    report.notes.push(`${resolveCompany.created} compan${resolveCompany.created === 1 ? "y" : "ies"} named in the CSV didn't exist and ${ctx.dryRun ? "would be" : "were"} created`);
  }
  if (!ctx.dryRun) void recordCrmActivityBulk(activity);
  apiLogger.info({
    msg: "crm-import:contacts-done", organizationId: ctx.organizationId, dryRun: ctx.dryRun,
    total: report.total, created: report.created, updated: report.updated,
    enriched: report.enriched, keptLocal: report.keptLocal, errorCount: report.errors.length,
    companiesCreated: resolveCompany.created,
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

// ── Deals ─────────────────────────────────────────────────────────────────────

export interface ImportDealsCtx extends ImportCtx {
  /** Where deals whose name matches no event land — a deal must have an event. */
  fallbackEventId: string;
  /** Used when the CSV has no currency column (Freshsales often omits it). */
  defaultCurrency?: string;
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
  const [fallbackEvent, events, stages, owners] = await Promise.all([
    db.event.findFirst({ where: { id: ctx.fallbackEventId, organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    db.event.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
    db.crmPipelineStage.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    // Owners are role-bound like every other assignment path (R2-M5): a CSV
    // owner email matching a MEMBER/ONSITE account counts as unmatched (left
    // unassigned + reported) rather than assigning CRM content to a role the
    // CRM excludes.
    db.user.findMany({ where: { organizationId: ctx.organizationId, role: { in: [...CRM_OWNER_ROLES] } }, select: { id: true, email: true } }),
  ]);
  if (!fallbackEvent) {
    apiLogger.warn({ msg: "crm-import:deals-bad-fallback-event", organizationId: ctx.organizationId, fallbackEventId: ctx.fallbackEventId });
    return { ok: false, code: "EVENT_NOT_FOUND", message: "Fallback event not found" };
  }
  const ownerByEmail = new Map(owners.map((u) => [u.email.toLowerCase(), u.id]));
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
  const stageMappingNotes = new Map<string, string>();
  let eventMatched = 0;
  let eventFallback = 0;
  let ownersUnmatched = 0;

  const defaultCurrency = (ctx.defaultCurrency ?? "USD").toUpperCase();

  for (let i = 0; i < parsed.rows.length; i++) {
    const rowNo = i + 1;
    try {
      const mapped = mapDealRow(parsed.rows[i]!, cols);
      if ("error" in mapped) {
        report.errors.push({ row: rowNo, error: mapped.error });
        continue;
      }
      const row = mapped.row;
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

      // ── Owner ──
      let ownerId: string | null = null;
      if (row.ownerEmail) {
        ownerId = ownerByEmail.get(row.ownerEmail) ?? null;
        if (!ownerId) ownersUnmatched++;
      } else if (row.ownerName) {
        ownersUnmatched++;
      }

      const companyId = await resolveCompany.idFor(row.companyName);
      const dryCompany = typeof companyId === "string" && companyId.startsWith("dry:");

      const existing = await db.crmDeal.findFirst({
        where: { organizationId: ctx.organizationId, externalSource: FRESHSALES_SOURCE, externalId: row.externalId },
      });
      // Deals match by externalId only (an EA-born deal has none), so "enrich"
      // is unreachable here — decideImportAction still guards kept-local.
      const action = decideImportAction(existing);

      const status: CrmDealStatus = outcome ?? "OPEN";
      const closeStamps =
        outcome === "WON"
          ? { wonAt: row.closedDate ?? new Date(), lostAt: null, lostReason: null }
          : outcome === "LOST"
            ? { lostAt: row.closedDate ?? new Date(), wonAt: null, lostReason: row.lostReason ?? null }
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
          await db.crmDeal.update({ where: { id: existing!.id }, data: { ...common, ...closeStampsForUpdate } });
          activity.push({
            organizationId: ctx.organizationId, entityType: "DEAL", entityId: existing!.id,
            action: "IMPORTED", actorId: ctx.userId,
            changes: { source: FRESHSALES_SOURCE, mode: "update", name: row.name, status, stage: stage.name },
          });
        }
      }
    } catch (err) {
      apiLogger.error({
        msg: "crm-import:deal-row-failed", organizationId: ctx.organizationId, row: rowNo,
        err: err instanceof Error ? err.message : String(err),
      });
      report.errors.push({ row: rowNo, error: "Row failed — see server logs" });
    }
  }

  report.notes.push(`Events: ${eventMatched} matched by name, ${eventFallback} → fallback "${fallbackEvent.name}"`);
  for (const note of stageMappingNotes.values()) report.notes.push(note);
  if (ownersUnmatched > 0) report.notes.push(`${ownersUnmatched} deal(s) had an owner we couldn't match to a team member — left unassigned`);
  if (resolveCompany.created > 0) {
    report.notes.push(`${resolveCompany.created} compan${resolveCompany.created === 1 ? "y" : "ies"} named in the CSV didn't exist and ${ctx.dryRun ? "would be" : "were"} created`);
  }

  if (!ctx.dryRun) void recordCrmActivityBulk(activity);
  apiLogger.info({
    msg: "crm-import:deals-done", organizationId: ctx.organizationId, dryRun: ctx.dryRun,
    total: report.total, created: report.created, updated: report.updated,
    keptLocal: report.keptLocal, errorCount: report.errors.length,
    eventMatched, eventFallback, ownersUnmatched,
  });
  return report;
}
