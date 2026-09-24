/**
 * CSV imports for the product catalogue and the supplier master, split into
 * two pure halves so the rules are testable without a database:
 *   parse*Import  reads the CSV text into typed rows and reports every row
 *                 it could not read (missing columns, bad values, duplicates
 *                 inside the file);
 *   plan*Import   decides, against what the organisation already holds,
 *                 which rows create, which update and which are skipped.
 * The services execute a plan through the same create/update functions the
 * single-row dialogs use, so an imported row obeys every rule a typed one
 * does. Nothing is ever deleted by an import.
 */
import { parseCSV, parseCSVHeaders } from "@/lib/csv-parser";
import { BUDGET_PRODUCT_SKU_RE } from "./budget-products-seed";
import { accountGroupCode } from "./budget-categories-seed";
import { proposeSupplierSchema } from "./budget-schemas";

export interface ImportColumn {
  name: string;
  sample: string;
  required?: boolean;
  hint?: string;
}

/** Header names are matched after trimming, lowercasing and dropping spaces, underscores and dashes. */
function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function columnIndex(headers: string[], columns: readonly ImportColumn[]): { index: Map<string, number>; missing: string[] } {
  const normalized = headers.map(normalizeHeader);
  const index = new Map<string, number>();
  const missing: string[] = [];
  for (const c of columns) {
    const i = normalized.indexOf(normalizeHeader(c.name));
    if (i >= 0) index.set(c.name, i);
    else if (c.required) missing.push(c.name);
  }
  return { index, missing };
}

function cell(fields: string[], index: Map<string, number>, name: string): string {
  const i = index.get(name);
  if (i === undefined) return "";
  return (fields[i] ?? "").trim();
}

/** "yes" / "true" / "1" / "active" and the empty cell mean active; "no" / "false" / "0" / "archived" / "inactive" mean archived. */
export function parseActiveCell(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "yes" || v === "y" || v === "true" || v === "1" || v === "active") return true;
  if (v === "no" || v === "n" || v === "false" || v === "0" || v === "archived" || v === "inactive") return false;
  return null;
}

/** Shared by the parsers: the header row alone, or an empty file, is a fatal error, not a zero-row import. */
function readCsv(text: string): { headers: string[]; rows: string[][]; fatal?: string } {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.trim()) return { headers: [], rows: [], fatal: "The file is empty." };
  const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
  const parsed = parseCSV(trimmed);
  if (parsed.error) return { headers: parseCSVHeaders(firstLine), rows: [], fatal: parsed.error };
  return { headers: parsed.headers, rows: parsed.rows };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const PRODUCT_IMPORT_COLUMNS: readonly ImportColumn[] = [
  { name: "sku", sample: "510323", required: true, hint: "the accounting key, normally the QuickBooks account number; an existing SKU is updated, a new one is created" },
  { name: "name", sample: "LED wall 6x3m", required: true },
  { name: "category", sample: "", hint: "leave blank when the SKU is an account number (it goes under its account group, 510323 under 510300); otherwise a category code from the Products page" },
  { name: "active", sample: "yes", hint: "yes or no; blank means yes" },
];

export interface ProductImportRow {
  rowNum: number;
  sku: string;
  name: string;
  /** Blank when the file leaves it to the SKU's account group. */
  categoryCode: string;
  active: boolean;
}

export interface ParsedImport<T> {
  rows: T[];
  errors: string[];
  /** Data rows in the file, readable or not. */
  totalRows: number;
  /** Set when the file as a whole cannot be read (no header, too many rows). */
  fatal?: string;
}

export function parseProductImport(text: string): ParsedImport<ProductImportRow> {
  const { headers, rows, fatal } = readCsv(text);
  if (fatal) return { rows: [], errors: [], totalRows: 0, fatal };
  const { index, missing } = columnIndex(headers, PRODUCT_IMPORT_COLUMNS);
  if (missing.length) return { rows: [], errors: [], totalRows: rows.length, fatal: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.` };

  const out: ProductImportRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  rows.forEach((fields, i) => {
    const rowNum = i + 2;
    const sku = cell(fields, index, "sku");
    const name = cell(fields, index, "name");
    const categoryCode = cell(fields, index, "category").toUpperCase();
    const activeRaw = cell(fields, index, "active");
    if (!sku || !name) {
      errors.push(`Row ${rowNum}: sku and name are required.`);
      return;
    }
    if (!BUDGET_PRODUCT_SKU_RE.test(sku)) {
      errors.push(`Row ${rowNum}: SKU "${sku}" may only hold letters, digits, dots, dashes and underscores (max 40).`);
      return;
    }
    if (name.length > 160) {
      errors.push(`Row ${rowNum}: the name is longer than 160 characters.`);
      return;
    }
    // A repeated SKU is flagged even when its first occurrence failed a later check.
    if (seen.has(sku)) {
      errors.push(`Row ${rowNum}: SKU "${sku}" appears earlier in the file.`);
      return;
    }
    seen.add(sku);
    const active = parseActiveCell(activeRaw);
    if (active === null) {
      errors.push(`Row ${rowNum}: active must be yes or no, got "${activeRaw}".`);
      return;
    }
    out.push({ rowNum, sku, name, categoryCode, active });
  });
  return { rows: out, errors, totalRows: rows.length };
}

export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  categoryId: string;
  isActive: boolean;
}

export interface ProductImportPlan {
  creates: { rowNum: number; sku: string; name: string; categoryId: string; active: boolean }[];
  updates: { rowNum: number; productId: string; sku: string; changes: { name?: string; categoryId?: string; isActive?: boolean } }[];
  /** Rows that matched an existing product with nothing to change. */
  unchanged: number;
  errors: string[];
}

/**
 * The category a row files under: an account-number SKU goes under its
 * account group when that category exists, and a different category code in
 * the file is an error rather than a silent correction; any other SKU needs a
 * known category code. The service applies the same rule again on write.
 */
function rowCategory(r: ProductImportRow, categoryByCode: Map<string, string>): { id: string } | { error: string } {
  const group = accountGroupCode(r.sku);
  const groupId = group ? categoryByCode.get(group) : undefined;
  const given = r.categoryCode.trim().toUpperCase();
  if (groupId) {
    if (given && categoryByCode.get(given) !== groupId) return { error: `Row ${r.rowNum}: SKU ${r.sku} belongs to account group ${group}, not "${r.categoryCode}". Leave the category blank.` };
    return { id: groupId };
  }
  if (!given) return { error: `Row ${r.rowNum}: SKU ${r.sku} is not an account number with a category of its own, so the category is required.` };
  const id = categoryByCode.get(given);
  if (!id) return { error: `Row ${r.rowNum}: unknown category code "${r.categoryCode}".` };
  return { id };
}

export function planProductImport(rows: ProductImportRow[], existing: ExistingProduct[], categories: { id: string; code: string }[]): ProductImportPlan {
  const categoryByCode = new Map(categories.map((c) => [c.code.toUpperCase(), c.id]));
  const bySku = new Map(existing.map((p) => [p.sku, p]));
  const plan: ProductImportPlan = { creates: [], updates: [], unchanged: 0, errors: [] };
  for (const r of rows) {
    const resolved = rowCategory(r, categoryByCode);
    if ("error" in resolved) {
      plan.errors.push(resolved.error);
      continue;
    }
    const categoryId = resolved.id;
    const cur = bySku.get(r.sku);
    if (!cur) {
      plan.creates.push({ rowNum: r.rowNum, sku: r.sku, name: r.name, categoryId, active: r.active });
      continue;
    }
    const changes: { name?: string; categoryId?: string; isActive?: boolean } = {};
    if (cur.name !== r.name) changes.name = r.name;
    if (cur.categoryId !== categoryId) changes.categoryId = categoryId;
    if (cur.isActive !== r.active) changes.isActive = r.active;
    if (Object.keys(changes).length === 0) plan.unchanged += 1;
    else plan.updates.push({ rowNum: r.rowNum, productId: cur.id, sku: r.sku, changes });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export const SUPPLIER_IMPORT_COLUMNS: readonly ImportColumn[] = [
  { name: "legalName", sample: "Gulf Audio Visual LLC", required: true },
  { name: "displayName", sample: "Gulf AV", hint: "blank uses the legal name" },
  { name: "code", sample: "GULFAV", hint: "blank makes one from the name plus four characters (ACME-7K2Q); an existing code is skipped" },
  { name: "billingLine1", sample: "Office 1204, Bay Square Building 3" },
  { name: "billingLine2", sample: "Business Bay" },
  { name: "billingCity", sample: "Dubai" },
  { name: "billingRegion", sample: "Dubai", hint: "state, emirate or province" },
  { name: "billingPostalCode", sample: "" },
  { name: "country", sample: "AE", hint: "the country of the billing address" },
  { name: "currency", sample: "AED", hint: "three letters; blank means AED" },
  { name: "taxRegistrationNo", sample: "100123456700003" },
  { name: "paymentTerms", sample: "30 days" },
  { name: "phone", sample: "+971 4 000 0000", hint: "the company's main number" },
  { name: "accountsEmail", sample: "accounts@gulfav.example", hint: "where invoices and remittances go" },
  { name: "contactName", sample: "Amal Haddad" },
  { name: "contactEmail", sample: "amal@gulfav.example" },
  { name: "contactPhone", sample: "+971 4 000 0000" },
  { name: "contactRole", sample: "Account manager" },
  { name: "notes", sample: "Preferred for LED walls" },
];

export interface SupplierImportRow {
  rowNum: number;
  legalName: string;
  displayName?: string;
  code?: string;
  country?: string | null;
  currency: string;
  taxRegistrationNo?: string | null;
  paymentTerms?: string | null;
  contacts?: { name: string; email?: string; phone?: string; role?: string }[];
  notes?: string | null;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingRegion?: string | null;
  billingPostalCode?: string | null;
  phone?: string | null;
  accountsEmail?: string | null;
}

export function parseSupplierImport(text: string): ParsedImport<SupplierImportRow> {
  const { headers, rows, fatal } = readCsv(text);
  if (fatal) return { rows: [], errors: [], totalRows: 0, fatal };
  const { index, missing } = columnIndex(headers, SUPPLIER_IMPORT_COLUMNS);
  if (missing.length) return { rows: [], errors: [], totalRows: rows.length, fatal: `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.` };

  const out: SupplierImportRow[] = [];
  const errors: string[] = [];
  const seenCodes = new Set<string>();
  const seenNames = new Set<string>();
  rows.forEach((fields, i) => {
    const rowNum = i + 2;
    const legalName = cell(fields, index, "legalName");
    if (!legalName) {
      errors.push(`Row ${rowNum}: legalName is required.`);
      return;
    }
    const contactName = cell(fields, index, "contactName");
    const contactEmail = cell(fields, index, "contactEmail");
    const contactPhone = cell(fields, index, "contactPhone");
    const contactRole = cell(fields, index, "contactRole");
    if (!contactName && (contactEmail || contactPhone || contactRole)) {
      errors.push(`Row ${rowNum}: contactName is required when a contact email, phone or role is given.`);
      return;
    }
    const opt = (name: string) => cell(fields, index, name) || undefined;
    const candidate = {
      code: opt("code")?.toUpperCase(),
      legalName,
      displayName: opt("displayName"),
      taxRegistrationNo: opt("taxRegistrationNo") ?? null,
      country: opt("country") ?? null,
      currency: (opt("currency") ?? "AED").toUpperCase(),
      contacts: contactName ? [{ name: contactName, email: contactEmail || undefined, phone: contactPhone || undefined, role: contactRole || undefined }] : undefined,
      paymentTerms: opt("paymentTerms") ?? null,
      notes: opt("notes") ?? null,
      billingLine1: opt("billingLine1") ?? null,
      billingLine2: opt("billingLine2") ?? null,
      billingCity: opt("billingCity") ?? null,
      billingRegion: opt("billingRegion") ?? null,
      billingPostalCode: opt("billingPostalCode") ?? null,
      phone: opt("phone") ?? null,
      accountsEmail: opt("accountsEmail") ?? null,
    };
    // The same rules the propose dialog obeys (email shape, lengths, the three-letter currency).
    const parsed = proposeSupplierSchema.safeParse(candidate);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
      const detail = Object.entries(fieldErrors).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`).join("; ");
      errors.push(`Row ${rowNum}: ${detail || "invalid values"}.`);
      return;
    }
    const codeKey = parsed.data.code?.toUpperCase();
    if (codeKey && seenCodes.has(codeKey)) {
      errors.push(`Row ${rowNum}: code "${codeKey}" appears earlier in the file.`);
      return;
    }
    const nameKey = legalName.toLowerCase();
    if (seenNames.has(nameKey)) {
      errors.push(`Row ${rowNum}: "${legalName}" appears earlier in the file.`);
      return;
    }
    if (codeKey) seenCodes.add(codeKey);
    seenNames.add(nameKey);
    out.push({ rowNum, ...parsed.data });
  });
  return { rows: out, errors, totalRows: rows.length };
}

export interface ExistingSupplier {
  code: string;
  legalName: string;
}

export interface SupplierImportPlan {
  creates: SupplierImportRow[];
  /** Rows already on the master, by code or by legal name: never re-created, never updated by an import. */
  skipped: { rowNum: number; reason: string }[];
}

export function planSupplierImport(rows: SupplierImportRow[], existing: ExistingSupplier[]): SupplierImportPlan {
  const byCode = new Map(existing.map((s) => [s.code.toUpperCase(), s]));
  const byName = new Map(existing.map((s) => [s.legalName.trim().toLowerCase(), s]));
  const plan: SupplierImportPlan = { creates: [], skipped: [] };
  for (const r of rows) {
    const codeHit = r.code ? byCode.get(r.code.toUpperCase()) : undefined;
    if (codeHit) {
      plan.skipped.push({ rowNum: r.rowNum, reason: `code ${codeHit.code} already exists (${codeHit.legalName})` });
      continue;
    }
    const nameHit = byName.get(r.legalName.trim().toLowerCase());
    if (nameHit) {
      plan.skipped.push({ rowNum: r.rowNum, reason: `"${r.legalName}" already exists as ${nameHit.code}` });
      continue;
    }
    plan.creates.push(r);
  }
  return plan;
}

/** The downloadable template: the header row plus one sample row, in column order. */
export function importTemplateCsv(columns: readonly ImportColumn[]): string {
  const header = columns.map((c) => c.name).join(",");
  const sample = columns.map((c) => (/[",\n]/.test(c.sample) ? `"${c.sample.replace(/"/g, '""')}"` : c.sample)).join(",");
  return `${header}\n${sample}\n`;
}
