/**
 * Freshsales CSV import — the PURE mapping layer.
 *
 * No `db`, no `next/server`: header resolution, row → payload mapping, and the
 * re-import conflict rule live here so they are unit-testable and the service
 * stays a thin orchestration layer (the planner-vs-applier split every other
 * pure lib in this module follows).
 *
 * DESIGN FACTS:
 *  - Freshsales export headers vary by plan/locale, so every field resolves
 *    through a SYNONYM list against the csv-parser's normalized headers
 *    (lowercased, whitespace stripped). Unrecognized columns are REPORTED, not
 *    silently ignored — a capped CSV that "imported fine" while dropping the
 *    Amount column would be the silent-truncation bug class.
 *  - "Recurring sync" here means re-uploading a fresh export. The conflict rule
 *    (decideImportAction) is what makes that safe: Freshsales wins on imported
 *    fields UNLESS the record was edited in EA-SYS after its last import — then
 *    EA-SYS wins and the row is reported as kept-local.
 */

export const FRESHSALES_SOURCE = "freshsales";

// ── Header synonyms (normalized: lowercase, whitespace stripped) ─────────────

type FieldSpec<T extends string> = Record<T, { synonyms: string[]; required?: boolean }>;

export const COMPANY_FIELDS = {
  externalId: { synonyms: ["id", "accountid", "salesaccountid"] },
  name: { synonyms: ["name", "accountname", "salesaccountname", "companyname"], required: true },
  website: { synonyms: ["website", "websiteurl"] },
  industry: { synonyms: ["industrytype", "industry"] },
  city: { synonyms: ["city"] },
  country: { synonyms: ["country"] },
  notes: { synonyms: ["description", "about", "notes"] },
} satisfies FieldSpec<string>;

export const CONTACT_FIELDS = {
  externalId: { synonyms: ["id", "contactid"] },
  firstName: { synonyms: ["firstname"], required: true },
  lastName: { synonyms: ["lastname"], required: true },
  email: { synonyms: ["email", "emails", "primaryemail", "emailaddress"], required: true },
  jobTitle: { synonyms: ["jobtitle", "designation"] },
  workPhone: { synonyms: ["workphone", "worknumber", "work"] },
  mobilePhone: { synonyms: ["mobile", "mobilenumber", "mobilephone"] },
  phone: { synonyms: ["phone", "phonenumber", "telephone"] },
  country: { synonyms: ["country"] },
  companyName: { synonyms: ["salesaccount", "salesaccounts", "accountname", "company", "companyname"] },
  tags: { synonyms: ["tags", "tag"] },
} satisfies FieldSpec<string>;

export const DEAL_FIELDS = {
  externalId: { synonyms: ["id", "dealid"] },
  name: { synonyms: ["name", "dealname"], required: true },
  amount: { synonyms: ["amount", "dealvalue", "dealamount", "value"] },
  currency: { synonyms: ["currency", "dealcurrency", "currencycode"] },
  stage: { synonyms: ["dealstage", "stage"] },
  expectedClose: { synonyms: ["expectedclose", "expectedclosedate"] },
  closedDate: { synonyms: ["closeddate", "actualclosedate", "wondate"] },
  companyName: { synonyms: ["salesaccount", "salesaccounts", "accountname", "company", "companyname"] },
  ownerEmail: { synonyms: ["salesowneremail", "owneremail"] },
  ownerName: { synonyms: ["salesowner", "owner"] },
  lostReason: { synonyms: ["lostreason", "closedlostreason", "deallostreason"] },
} satisfies FieldSpec<string>;

export interface ColumnResolution<T extends string> {
  /** field → column index (-1 when the CSV doesn't carry it). */
  index: Record<T, number>;
  /** Required fields whose column is missing — the import refuses to start. */
  missingRequired: T[];
  /** Headers we matched (for the report). */
  matched: Partial<Record<T, string>>;
  /** CSV headers nothing claimed — reported so a dropped column is never silent. */
  unrecognized: string[];
}

/** Resolve normalized CSV headers against a field spec's synonym lists. */
export function resolveColumns<T extends string>(
  headers: string[],
  spec: FieldSpec<T>,
): ColumnResolution<T> {
  const index = {} as Record<T, number>;
  const matched: Partial<Record<T, string>> = {};
  const claimed = new Set<number>();
  const missingRequired: T[] = [];

  for (const field of Object.keys(spec) as T[]) {
    const { synonyms, required } = spec[field];
    let found = -1;
    for (const syn of synonyms) {
      const i = headers.indexOf(syn);
      if (i >= 0 && !claimed.has(i)) {
        found = i;
        break;
      }
    }
    index[field] = found;
    if (found >= 0) {
      claimed.add(found);
      matched[field] = headers[found];
    } else if (required) {
      missingRequired.push(field);
    }
  }

  const unrecognized = headers.filter((_, i) => !claimed.has(i));
  return { index, missingRequired, matched, unrecognized };
}

// ── Row mappers ───────────────────────────────────────────────────────────────

const cell = (fields: string[], i: number): string | undefined => {
  if (i < 0) return undefined;
  const v = fields[i]?.trim();
  return v || undefined;
};

export interface CompanyRow {
  externalId?: string;
  name: string;
  website?: string;
  industry?: string;
  city?: string;
  country?: string;
  notes?: string;
}

export function mapCompanyRow(
  fields: string[],
  cols: ColumnResolution<keyof typeof COMPANY_FIELDS & string>,
): { row: CompanyRow } | { error: string } {
  const name = cell(fields, cols.index.name);
  if (!name) return { error: "Missing company name" };
  return {
    row: {
      externalId: cell(fields, cols.index.externalId),
      name,
      website: cell(fields, cols.index.website),
      industry: cell(fields, cols.index.industry),
      city: cell(fields, cols.index.city),
      country: cell(fields, cols.index.country),
      notes: cell(fields, cols.index.notes),
    },
  };
}

export interface ContactRow {
  externalId?: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle?: string;
  phone?: string;
  mobile?: string;
  country?: string;
  companyName?: string;
  /** Undefined when the CSV has no tags column OR the cell is blank. */
  tags?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mapContactRow(
  fields: string[],
  cols: ColumnResolution<keyof typeof CONTACT_FIELDS & string>,
): { row: ContactRow } | { error: string } {
  const firstName = cell(fields, cols.index.firstName);
  const lastName = cell(fields, cols.index.lastName);
  // Freshsales can export multiple emails comma-separated; the first is primary.
  const rawEmail = cell(fields, cols.index.email)?.split(",")[0]?.trim();
  if (!firstName || !lastName) return { error: "Missing first or last name" };
  if (!rawEmail) return { error: "Missing email" };
  if (!EMAIL_RE.test(rawEmail)) return { error: `Invalid email "${rawEmail}"` };

  return {
    row: {
      externalId: cell(fields, cols.index.externalId),
      firstName,
      lastName,
      email: rawEmail,
      jobTitle: cell(fields, cols.index.jobTitle),
      // Work number wins for phone; mobile now lands in its OWN field (it used
      // to collapse into phone as a fallback, losing the distinction).
      phone: cell(fields, cols.index.workPhone) ?? cell(fields, cols.index.phone),
      mobile: cell(fields, cols.index.mobilePhone),
      country: cell(fields, cols.index.country),
      companyName: cell(fields, cols.index.companyName),
      tags: parseTagsCell(cell(fields, cols.index.tags)),
    },
  };
}

/** Freshsales tag cells are comma- or semicolon-separated. Blank → undefined. */
function parseTagsCell(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const tags = v.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

export interface DealRow {
  externalId?: string;
  name: string;
  amount?: number;
  currency?: string;
  stageName?: string;
  expectedClose?: Date;
  closedDate?: Date;
  companyName?: string;
  ownerEmail?: string;
  ownerName?: string;
  lostReason?: string;
}

function parseDateCell(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

export function mapDealRow(
  fields: string[],
  cols: ColumnResolution<keyof typeof DEAL_FIELDS & string>,
): { row: DealRow } | { error: string } {
  const name = cell(fields, cols.index.name);
  if (!name) return { error: "Missing deal name" };

  let amount: number | undefined;
  const rawAmount = cell(fields, cols.index.amount);
  if (rawAmount !== undefined) {
    // Tolerate "40,000.00" / "USD 40000" style cells.
    const cleaned = rawAmount.replace(/[^0-9.\-]/g, "");
    const n = Number(cleaned);
    if (!cleaned || !Number.isFinite(n)) return { error: `Invalid amount "${rawAmount}"` };
    amount = n;
  }

  return {
    row: {
      externalId: cell(fields, cols.index.externalId),
      name,
      amount,
      currency: cell(fields, cols.index.currency)?.toUpperCase(),
      stageName: cell(fields, cols.index.stage),
      expectedClose: parseDateCell(cell(fields, cols.index.expectedClose)),
      closedDate: parseDateCell(cell(fields, cols.index.closedDate)),
      companyName: cell(fields, cols.index.companyName),
      ownerEmail: cell(fields, cols.index.ownerEmail)?.toLowerCase(),
      ownerName: cell(fields, cols.index.ownerName),
      lostReason: cell(fields, cols.index.lostReason),
    },
  };
}

// ── Deal stage / outcome mapping ──────────────────────────────────────────────

/** WON/LOST detection from a Freshsales stage name ("Closed won", "Won", …). */
export function dealOutcomeFromStageName(stageName: string | undefined): "WON" | "LOST" | null {
  if (!stageName) return null;
  const n = stageName.trim().toLowerCase();
  if (n === "won" || n === "closed won" || n === "closedwon") return "WON";
  if (n === "lost" || n === "closed lost" || n === "closedlost") return "LOST";
  return null;
}

/**
 * Match a deal name against event names — "Abbott — BRIDGES 2026 Gold" should
 * land on the BRIDGES 2026 event. Longest event name that appears (case-
 * insensitive) in the deal name wins; ambiguity resolves to the more specific
 * (longer) name. Returns null when nothing matches (→ the fallback event).
 */
export function matchEventByName(
  dealName: string,
  events: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const hay = dealName.toLowerCase();
  let best: { id: string; name: string } | null = null;
  for (const e of events) {
    const needle = e.name.trim().toLowerCase();
    if (needle.length < 4) continue; // "Gala"-length names match everything
    if (hay.includes(needle) && (!best || needle.length > best.name.trim().length)) {
      best = e;
    }
  }
  return best;
}

// ── The re-import conflict rule ───────────────────────────────────────────────

export type ImportAction = "create" | "update" | "enrich" | "skip-kept-local";

/**
 * `updatedAt` is bumped by our own import writes, so a strict `>` against the
 * lastImportedAt stamped in the same transaction can differ by milliseconds.
 * Anything inside this window is "the import's own write", not a human edit.
 */
const OWN_WRITE_TOLERANCE_MS = 5_000;

/**
 * Decide what a matched row gets on re-import:
 *  - no match                            → create
 *  - matched an EA-born row (never
 *    imported: lastImportedAt null)      → enrich (fill blanks + stamp the
 *    externalId; NEVER overwrite what a human typed — the enrich-only-sync rule).
 *    EA-born rows stay enrich FOREVER: the importer deliberately never stamps
 *    lastImportedAt on an enrich, because stamping it would graduate the row to
 *    the Freshsales-wins `update` path on the NEXT import and overwrite (or
 *    NULL) exactly the human-typed fields the enrich preserved (review R2-H1)
 *  - previously imported, untouched
 *    in EA-SYS since                     → update (Freshsales wins)
 *  - previously imported, but edited in
 *    EA-SYS after the last import        → skip-kept-local (EA-SYS wins; reported)
 */
export function decideImportAction(
  existing: { updatedAt: Date; lastImportedAt: Date | null } | null,
): ImportAction {
  if (!existing) return "create";
  if (!existing.lastImportedAt) return "enrich";
  const editedSinceImport =
    existing.updatedAt.getTime() > existing.lastImportedAt.getTime() + OWN_WRITE_TOLERANCE_MS;
  return editedSinceImport ? "skip-kept-local" : "update";
}
