/**
 * The supplier master as CSV (24 September 2026, owner: "import or export
 * suppliers, reserved to admin").
 *
 * ROUND-TRIPPABLE BY CONSTRUCTION. The first columns are
 * `SUPPLIER_IMPORT_COLUMNS`, in the import's own order and under its own names,
 * so a file can be exported, edited and imported again. Three read-only
 * columns follow (approvalStatus, active, additionalContacts); the importer
 * maps columns by name and ignores the rest, so they cost the round trip
 * nothing, and without them a Rejected supplier and an Approved one would read
 * identically in the file.
 *
 * BANK DETAILS ARE NEVER EXPORTED. The input type has no field for them, so a
 * caller cannot pass them in by accident; the service read that feeds this
 * does not select the column either. The import cannot take them back, and
 * they should not leave the system in a spreadsheet.
 *
 * One row per supplier. The import holds one contact per row, so the first
 * contact fills the contact columns and any others are written into
 * additionalContacts, where a person can read them. Re-importing that file
 * does not recreate them; that is stated in the user guide.
 *
 * Pure: no database, no request. Cells go through `toCsv`, which neutralises
 * formula prefixes.
 */
import { toCsv } from "@/lib/csv-escape";
import { SUPPLIER_IMPORT_COLUMNS } from "./catalogue-import";

export interface SupplierExportInput {
  code: string;
  legalName: string;
  displayName: string;
  country: string | null;
  currency: string;
  taxRegistrationNo: string | null;
  paymentTerms: string | null;
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingRegion: string | null;
  billingPostalCode: string | null;
  phone: string | null;
  accountsEmail: string | null;
  /** The `Supplier.contacts` JSON column, read defensively. */
  contacts: unknown;
  notes: string | null;
  approvalStatus: string;
  isActive: boolean;
}

interface Contact {
  name: string;
  email?: string;
  phone?: string;
  role?: string;
}

/** The read-only columns after the importable ones. */
export const SUPPLIER_EXPORT_EXTRA_COLUMNS = ["approvalStatus", "active", "additionalContacts"] as const;

export const SUPPLIER_EXPORT_HEADER: readonly string[] = [
  ...SUPPLIER_IMPORT_COLUMNS.map((c) => c.name),
  ...SUPPLIER_EXPORT_EXTRA_COLUMNS,
];

/** A JSON column is whatever was written; keep only entries that carry a name. */
function readContacts(raw: unknown): Contact[] {
  if (!Array.isArray(raw)) return [];
  const out: Contact[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    out.push({ name, email: str(r.email), phone: str(r.phone), role: str(r.role) });
  }
  return out;
}

/** "Amal Haddad <amal@x.example> +971 4 000 0000 (Account manager)" */
function describeContact(c: Contact): string {
  return [c.name, c.email ? `<${c.email}>` : "", c.phone ?? "", c.role ? `(${c.role})` : ""].filter(Boolean).join(" ");
}

/** The value of each importable column, keyed by the import's column name. */
function importableCells(s: SupplierExportInput, first: Contact | undefined): Record<string, string> {
  return {
    legalName: s.legalName,
    displayName: s.displayName,
    code: s.code,
    billingLine1: s.billingLine1 ?? "",
    billingLine2: s.billingLine2 ?? "",
    billingCity: s.billingCity ?? "",
    billingRegion: s.billingRegion ?? "",
    billingPostalCode: s.billingPostalCode ?? "",
    country: s.country ?? "",
    currency: s.currency,
    taxRegistrationNo: s.taxRegistrationNo ?? "",
    paymentTerms: s.paymentTerms ?? "",
    phone: s.phone ?? "",
    accountsEmail: s.accountsEmail ?? "",
    contactName: first?.name ?? "",
    contactEmail: first?.email ?? "",
    contactPhone: first?.phone ?? "",
    contactRole: first?.role ?? "",
    notes: s.notes ?? "",
  };
}

export function buildSupplierCsv(suppliers: readonly SupplierExportInput[]): string {
  const rows: string[][] = [[...SUPPLIER_EXPORT_HEADER]];
  for (const s of suppliers) {
    const [first, ...rest] = readContacts(s.contacts);
    const cells = importableCells(s, first);
    rows.push([
      // Driven by the import's column list, so adding an import column cannot
      // leave the export a column short without failing the parity test.
      ...SUPPLIER_IMPORT_COLUMNS.map((c) => cells[c.name] ?? ""),
      s.approvalStatus,
      s.isActive ? "yes" : "no",
      rest.map(describeContact).join("; "),
    ]);
  }
  return `${toCsv(rows)}\n`;
}

export function supplierExportFilename(now: Date): string {
  return `suppliers-${now.toISOString().slice(0, 10)}.csv`;
}
