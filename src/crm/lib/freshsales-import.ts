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

import { LIFECYCLE_VALUES, CONTACT_STATUS_VALUES } from "@/crm/lib/crm-types";

export const FRESHSALES_SOURCE = "freshsales";

// ── Date formats ──────────────────────────────────────────────────────────────
/**
 * THE AMBIGUITY THIS EXISTS TO KILL.
 *
 * `05/03/2026` is 5 March in Dubai and 3 May in New York, and nothing in the file
 * says which. The importer used to call `new Date(cell)`, which silently applies
 * V8's US-centric lenient parser — so on a day-first export the first ~12 days of
 * every month imported as the WRONG DATE, and days 13-31 came back Invalid and
 * were dropped to `undefined`. A dropped close date is not benign: a won deal
 * with no date fell back to `new Date()`, stamping TODAY, which is how "deals won
 * in July" quietly reports zero.
 *
 * So the format is now DECLARED by the operator, never guessed, and a value that
 * doesn't fit becomes a ROW ERROR the dry run shows. Auto-detection was
 * considered and rejected: scanning for a day > 12 works right up until a file
 * where every date happens to fall on the 1st-12th, at which point it guesses —
 * and a guess that is usually right is exactly the failure mode here.
 */
export const CSV_DATE_FORMATS = ["iso", "dmy", "mdy"] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

export const CSV_DATE_FORMAT_LABELS: Record<CsvDateFormat, string> = {
  iso: "YYYY-MM-DD (ISO)",
  dmy: "DD/MM/YYYY (day first)",
  mdy: "MM/DD/YYYY (month first)",
};

export const DEFAULT_CSV_DATE_FORMAT: CsvDateFormat = "iso";

export function isCsvDateFormat(v: unknown): v is CsvDateFormat {
  return typeof v === "string" && (CSV_DATE_FORMATS as readonly string[]).includes(v);
}

/** A date cell is one of: absent/blank, a real date, or a reportable error. */
export type DateCellResult =
  | { kind: "blank" }
  | { kind: "date"; date: Date }
  | { kind: "error"; message: string };

/** `YYYY-MM-DD`, optionally followed by a time we ignore (dates here are day-precision). */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
/** Three numeric parts separated by / - or . — the ambiguous shape the picker resolves. */
const TRIPLE_RE = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})(?:[T ].*)?$/;

/**
 * Build a day-precision Date at UTC midnight, REJECTING a rolled-over date.
 *
 * `Date.UTC(2026, 1, 31)` happily yields 3 March; comparing the components back
 * is what turns "31/02/2026" into an error instead of a silently shifted row.
 * UTC (not local) midnight also removes the second bug the old parser had: local
 * parsing made a date render one day earlier once serialised to UTC.
 */
function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Parse one date cell under an explicitly declared format.
 *
 * ISO (`YYYY-MM-DD`) is accepted under EVERY format because it is unambiguous —
 * a file that mixes ISO into a day-first export still imports correctly. Anything
 * else must match the declared format. Two-digit years are refused rather than
 * century-guessed: that would be the same class of silent corruption one level down.
 */
export function parseDateCell(v: string | undefined, format: CsvDateFormat): DateCellResult {
  const raw = v?.trim();
  if (!raw) return { kind: "blank" };

  const iso = ISO_RE.exec(raw);
  if (iso) {
    const d = utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return d ? { kind: "date", date: d } : { kind: "error", message: `"${raw}" is not a real calendar date` };
  }

  const triple = TRIPLE_RE.exec(raw);
  if (!triple) {
    return { kind: "error", message: `"${raw}" is not a date we can read (expected ${CSV_DATE_FORMAT_LABELS[format]})` };
  }
  const [a, b, c] = [triple[1]!, triple[2]!, triple[3]!];

  // A 4-digit leading part is year-first regardless of the picker (also unambiguous).
  if (a.length === 4) {
    const d = utcDate(Number(a), Number(b), Number(c));
    return d ? { kind: "date", date: d } : { kind: "error", message: `"${raw}" is not a real calendar date` };
  }

  // `iso` DECLARES "this file is YYYY-MM-DD", so a d/m/y triple under it has no
  // stated order and MUST NOT be read. Without this the ternary below (binary:
  // dmy vs everything-else) quietly gave `iso` the month-first branch — which is
  // the exact silent corruption this whole module exists to prevent, sitting on
  // the DEFAULT path. Refuse loudly and name the two orders instead.
  if (format === "iso") {
    return {
      kind: "error",
      message: `"${raw}" is not an ISO date (YYYY-MM-DD). Set "Date format in this file" to DD/MM/YYYY or MM/DD/YYYY — we will not guess the order.`,
    };
  }

  if (c.length !== 4) {
    return {
      kind: "error",
      message: `"${raw}" has a 2-digit year — re-export with 4-digit years so the century isn't guessed`,
    };
  }

  const year = Number(c);
  const day = format === "dmy" ? Number(a) : Number(b);
  const month = format === "dmy" ? Number(b) : Number(a);
  const d = utcDate(year, month, day);
  return d
    ? { kind: "date", date: d }
    : {
        kind: "error",
        message: `"${raw}" is not a valid ${CSV_DATE_FORMAT_LABELS[format]} date — is the file in the other order?`,
      };
}

/** Human echo for the dry-run report: "05/03/2026 → 5 Mar 2026". */
export function formatDateEcho(raw: string, parsed: Date): string {
  const shown = parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${raw} → ${shown}`;
}

// ── Sample CSV templates ──────────────────────────────────────────────────────
// Headers here are human-readable Freshsales-style names that NORMALIZE (lower +
// whitespace-stripped, per csv-parser) to a synonym the importer recognizes, so
// a downloaded sample always imports cleanly. A unit test resolves every sample
// header against its field spec, so the samples can't drift from the synonyms.

interface SampleColumn {
  header: string;
  example: string;
}

const COMPANY_SAMPLE: SampleColumn[] = [
  { header: "Id", example: "FS-1001" },
  { header: "Name", example: "Abbott Laboratories" },
  { header: "Website", example: "https://abbott.com" },
  { header: "Industry", example: "Pharmaceuticals" },
  { header: "City", example: "Dubai" },
  { header: "Country", example: "United Arab Emirates" },
  { header: "Phone", example: "+97141234567" },
  { header: "Tags", example: "sponsor;pharma" },
  { header: "Description", example: "Key sponsor account" },
];

const CONTACT_SAMPLE: SampleColumn[] = [
  { header: "Id", example: "FS-2001" },
  { header: "First Name", example: "Jane" },
  { header: "Last Name", example: "Doe" },
  { header: "Email", example: "jane.doe@abbott.com" },
  { header: "Job Title", example: "Sponsorship Manager" },
  { header: "Work Phone", example: "+9714000000" },
  { header: "Mobile", example: "+971500000000" },
  { header: "Sales Account", example: "Abbott Laboratories" },
  { header: "Country", example: "United Arab Emirates" },
  { header: "Tags", example: "sponsor;gold" },
  { header: "Sales Owner", example: "Krishna P" },
  { header: "Sales Owner Email", example: "krishna@meetingmindsdubai.com" },
  { header: "Lifecycle Stage", example: "ENGAGED" },
  { header: "Status", example: "NEGOTIATION" },
];

const DEAL_SAMPLE_ROWS: SampleColumn[][] = [
  [
    { header: "Id", example: "FS-3001" },
    { header: "Name", example: "Abbott — BRIDGES 2026 Gold" },
    { header: "Amount", example: "40000" },
    { header: "Currency", example: "USD" },
    { header: "Deal Stage", example: "Negotiation" },
    { header: "Expected Close", example: "2026-03-01" },
    { header: "Closed Date", example: "" },
    { header: "Sales Account", example: "Abbott Laboratories" },
    { header: "Sales Owner", example: "Krishna P" },
    { header: "Sales Owner Email", example: "krishna@meetingmindsdubai.com" },
    { header: "Deal Type", example: "Sponsorship" },
    { header: "Tags", example: "multi-year;renewal" },
    { header: "Lost Reason", example: "" },
  ],
  [
    { header: "Id", example: "FS-3002" },
    { header: "Name", example: "Pfizer — BRIDGES 2026 Exhibitor" },
    { header: "Amount", example: "15000" },
    { header: "Currency", example: "USD" },
    { header: "Deal Stage", example: "Closed Won" },
    { header: "Expected Close", example: "2026-02-15" },
    { header: "Closed Date", example: "2026-02-10" },
    { header: "Sales Account", example: "Pfizer" },
    { header: "Sales Owner", example: "Krishna P" },
    { header: "Sales Owner Email", example: "krishna@meetingmindsdubai.com" },
    { header: "Deal Type", example: "Sponsorship" },
    { header: "Tags", example: "multi-year;renewal" },
    { header: "Lost Reason", example: "" },
  ],
];

/** The sample columns (header + one example each) for a given import type. */
export function sampleColumnsFor(type: "companies" | "contacts" | "deals"): SampleColumn[] {
  if (type === "companies") return COMPANY_SAMPLE;
  if (type === "contacts") return CONTACT_SAMPLE;
  return DEAL_SAMPLE_ROWS[0]!;
}

/** Wrap a CSV cell only when it contains a comma, quote, or newline (RFC 4180). */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * A ready-to-fill sample CSV for one import type — the exact columns the
 * importer accepts, with one or two example rows. Client-safe (pure).
 */
export function buildSampleCsv(type: "companies" | "contacts" | "deals"): string {
  const rows = type === "deals" ? DEAL_SAMPLE_ROWS : [sampleColumnsFor(type)];
  const header = rows[0]!.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => r.map((c) => csvCell(c.example)).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}

// ── Header synonyms (normalized: lowercase, whitespace stripped) ─────────────

type FieldSpec<T extends string> = Record<T, { synonyms: string[]; required?: boolean }>;

export const COMPANY_FIELDS = {
  externalId: { synonyms: ["id", "accountid", "salesaccountid"] },
  name: { synonyms: ["name", "accountname", "salesaccountname", "companyname"], required: true },
  website: { synonyms: ["website", "websiteurl"] },
  industry: { synonyms: ["industrytype", "industry"] },
  city: { synonyms: ["city"] },
  country: { synonyms: ["country"] },
  phone: { synonyms: ["phone", "phonenumber", "workphone", "telephone"] },
  tags: { synonyms: ["tags", "tag"] },
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
  ownerEmail: { synonyms: ["salesowneremail", "owneremail", "contactowneremail"] },
  ownerName: { synonyms: ["salesowner", "owner", "contactowner"] },
  lifecycleStage: { synonyms: ["lifecyclestage", "lifecycle"] },
  status: { synonyms: ["status", "contactstatus", "salesstatus"] },
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
  ownerEmail: { synonyms: ["salesowneremail", "owneremail", "dealowneremail"] },
  ownerName: { synonyms: ["salesowner", "owner", "dealowner"] },
  // `dealreason` is the label the API field `deal_reason_id` most likely renders
  // as — without it a whole column of lost reasons imported as "unrecognized".
  lostReason: { synonyms: ["lostreason", "closedlostreason", "deallostreason", "dealreason", "reasonforloss"] },
  dealType: { synonyms: ["dealtype", "type"] },
  tags: { synonyms: ["tags", "tag"] },
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
  phone?: string;
  tags?: string[];
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
      phone: cell(fields, cols.index.phone),
      tags: parseTagsCell(cell(fields, cols.index.tags)),
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
  ownerEmail?: string;
  ownerName?: string;
  /** Already coerced to our enum, or undefined when absent/unrecognised. */
  lifecycleStage?: CrmLifecycleStageValue;
  status?: CrmContactStatusValue;
  /** Values we saw but couldn't map onto an enum — reported, never dropped silently. */
  unmappedEnums: string[];
}

// The two contact ladders come from crm-types.ts — the SAME tuples the dropdown,
// the route Zod and the detail form use. An earlier version of this file
// re-declared them locally, justified as "@prisma/client isn't client-safe";
// that was beside the point, since crm-types.ts is client-safe and already had
// them. A real drift test against the Prisma enums now lives in
// __tests__/crm/crm-enum-drift.test.ts (the previous comment claimed one existed
// when none did — do not restate a guarantee without grepping for it first).
export const CRM_LIFECYCLE_VALUES = LIFECYCLE_VALUES;
export const CRM_CONTACT_STATUS_VALUES = CONTACT_STATUS_VALUES;
export type CrmLifecycleStageValue = (typeof CRM_LIFECYCLE_VALUES)[number];
export type CrmContactStatusValue = (typeof CRM_CONTACT_STATUS_VALUES)[number];

/**
 * Coerce a free-text CSV cell onto one of our enum values.
 *
 * Tolerant of the casing and punctuation a CRM export uses ("Un-qualified",
 * "un qualified" → UNQUALIFIED), but never CREATIVE: an unrecognised value returns null and
 * is reported rather than being coerced to a default. Landing every unknown
 * status on NEW would silently rewrite the pipeline's shape.
 */
function coerceEnum<T extends string>(v: string | undefined, allowed: readonly T[]): T | null {
  if (!v) return null;
  const key = v.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return allowed.find((a) => a === key) ?? null;
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

  const unmappedEnums: string[] = [];
  const rawLifecycle = cell(fields, cols.index.lifecycleStage);
  const rawStatus = cell(fields, cols.index.status);
  const lifecycleStage = coerceEnum(rawLifecycle, CRM_LIFECYCLE_VALUES);
  const status = coerceEnum(rawStatus, CRM_CONTACT_STATUS_VALUES);
  // Unmapped is a REPORT, not a row error: a stray lifecycle label shouldn't
  // cost you the contact, but it must not vanish without a word either.
  if (rawLifecycle && !lifecycleStage) unmappedEnums.push(`lifecycle "${rawLifecycle}"`);
  if (rawStatus && !status) unmappedEnums.push(`status "${rawStatus}"`);

  return {
    row: {
      lifecycleStage: lifecycleStage ?? undefined,
      status: status ?? undefined,
      unmappedEnums,
      ownerEmail: cell(fields, cols.index.ownerEmail)?.toLowerCase(),
      ownerName: cell(fields, cols.index.ownerName),
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
  dealTypeName?: string;
  tags?: string[];
}

export function mapDealRow(
  fields: string[],
  cols: ColumnResolution<keyof typeof DEAL_FIELDS & string>,
  dateFormat: CsvDateFormat,
): { row: DealRow } | { error: string } {
  const name = cell(fields, cols.index.name);
  if (!name) return { error: "Missing deal name" };

  // A present-but-unreadable date is a ROW ERROR, never a silent `undefined`.
  // The old behaviour dropped it, and a dropped close date on a won deal then
  // fell through to a today-stamp — losing the win history for good.
  const dates: Partial<Record<"expectedClose" | "closedDate", Date>> = {};
  for (const [field, label] of [
    ["expectedClose", "Expected Close"],
    ["closedDate", "Closed Date"],
  ] as const) {
    const result = parseDateCell(cell(fields, cols.index[field]), dateFormat);
    if (result.kind === "error") return { error: `${label}: ${result.message}` };
    if (result.kind === "date") dates[field] = result.date;
  }

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
      expectedClose: dates.expectedClose,
      closedDate: dates.closedDate,
      companyName: cell(fields, cols.index.companyName),
      ownerEmail: cell(fields, cols.index.ownerEmail)?.toLowerCase(),
      ownerName: cell(fields, cols.index.ownerName),
      lostReason: cell(fields, cols.index.lostReason),
      dealTypeName: cell(fields, cols.index.dealType),
      tags: parseTagsCell(cell(fields, cols.index.tags)),
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
