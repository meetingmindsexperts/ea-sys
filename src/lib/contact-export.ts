/**
 * Every column the export writes, in file order (Oct 23, 2026). One list drives
 * the select, the header row and the cells, so they cannot drift apart: the old
 * hand-kept trio had silently left out city, country and nine other fields.
 * Deliberately absent: `photo` (a storage path, not data) and `eventIds`
 * (internal ids that mean nothing in a spreadsheet).
 */
export const EXPORT_COLUMNS = [
  "title", "firstName", "lastName", "email", "additionalEmail",
  "organization", "jobTitle", "role", "specialty", "customSpecialty", "registrationType",
  "phone", "city", "state", "zipCode", "country",
  "associationName", "memberId", "studentId", "studentIdExpiry",
  "bio", "tags", "notes", "createdAt",
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/**
 * Most rows one export returns. The route builds the file in memory on the box
 * that also serves the door scanner; the dialog reads this to warn before a
 * file would be cut short, since the book is larger than the cap.
 */
export const EXPORT_ROW_CAP = 25_000;

/** One value as CSV text: arrays comma-joined, dates as YYYY-MM-DD. */
export function exportCell(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.join(",");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** What the export dialog shows for each column, grouped as the dialog lists them. */
export const EXPORT_COLUMN_GROUPS: { label: string; columns: { key: ExportColumn; label: string }[] }[] = [
  {
    label: "Name and contact",
    columns: [
      { key: "title", label: "Title" },
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "email", label: "Email" },
      { key: "additionalEmail", label: "Additional email" },
      { key: "phone", label: "Phone" },
    ],
  },
  {
    label: "Work",
    columns: [
      { key: "organization", label: "Organisation" },
      { key: "jobTitle", label: "Job title" },
      { key: "role", label: "Role" },
      { key: "specialty", label: "Specialty" },
      { key: "customSpecialty", label: "Custom specialty" },
      { key: "registrationType", label: "Registration type" },
    ],
  },
  {
    label: "Address",
    columns: [
      { key: "city", label: "City" },
      { key: "state", label: "State" },
      { key: "zipCode", label: "Zip code" },
      { key: "country", label: "Country" },
    ],
  },
  {
    label: "Membership",
    columns: [
      { key: "associationName", label: "Association" },
      { key: "memberId", label: "Member ID" },
      { key: "studentId", label: "Student ID" },
      { key: "studentIdExpiry", label: "Student ID expiry" },
    ],
  },
  {
    label: "Other",
    columns: [
      { key: "bio", label: "Bio" },
      { key: "tags", label: "Tags" },
      { key: "notes", label: "Notes" },
      { key: "createdAt", label: "Date added" },
    ],
  },
];

/**
 * Ticked when the dialog opens (owner, Oct 23, 2026): enough to identify and
 * place a person. Phone, bio, notes and the ID numbers are opt-in, so the
 * sensitive columns leave only when someone chose them.
 */
export const DEFAULT_EXPORT_COLUMNS: readonly ExportColumn[] = [
  "firstName", "lastName", "email", "organization", "jobTitle", "specialty", "city", "country",
];

/**
 * Private rather than marketing data (owner, Oct 23, 2026; docs/BASE_ROLE_PLAN.md
 * D4): exported only with `contacts.export.sensitive`. Every built-in role
 * that exports contacts holds it, so this narrows custom roles only, such as a
 * marketing colleague's export role.
 */
export const SENSITIVE_EXPORT_COLUMNS: readonly ExportColumn[] = ["phone", "notes", "memberId", "studentId", "studentIdExpiry"];
const SENSITIVE = new Set<string>(SENSITIVE_EXPORT_COLUMNS);

/** The sensitive columns among the chosen ones. */
export function sensitiveColumnsIn(columns: readonly ExportColumn[]): ExportColumn[] {
  return columns.filter((c) => SENSITIVE.has(c));
}

const KNOWN = new Set<string>(EXPORT_COLUMNS);

/**
 * The `columns` query parameter, comma-separated. Absent means every column, so
 * an API-key caller written before the picker keeps its file. Unknown names
 * are refused rather than skipped, so a typo cannot quietly shorten a file.
 * The result is always in file order, whatever order the request used.
 */
export function parseExportColumns(
  raw: string | null,
): { ok: true; columns: ExportColumn[] } | { ok: false; error: string; unknown: string[] } {
  if (raw === null) return { ok: true, columns: [...EXPORT_COLUMNS] };
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.length === 0) return { ok: false, error: "Choose at least one column", unknown: [] };
  const unknown = requested.filter((c) => !KNOWN.has(c));
  if (unknown.length > 0) return { ok: false, error: `Unknown columns: ${unknown.join(", ")}`, unknown };
  const chosen = new Set(requested);
  return { ok: true, columns: EXPORT_COLUMNS.filter((c) => chosen.has(c)) };
}

/**
 * Plain text columns the contacts importer reads beside its original twelve
 * (Oct 23, 2026). Named exactly as the export writes them, so an exported file
 * imports back. `createdAt` is export-only: the import date is the new row's.
 */
export const IMPORT_TEXT_COLUMNS = [
  "additionalEmail", "customSpecialty", "registrationType",
  "city", "state", "zipCode", "country",
  "associationName", "memberId", "studentId",
] as const satisfies readonly ExportColumn[];
export type ImportTextColumn = (typeof IMPORT_TEXT_COLUMNS)[number];

/** A YYYY-MM-DD cell as a UTC date, or null when it is not a real calendar date. */
export function parseImportDate(cell: string | null | undefined): Date | null {
  const m = cell?.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === m[0] ? date : null;
}

/**
 * The longest value the importer stores per optional column (Oct 23, 2026).
 * The same caps as the Add and Edit Contact forms (`POST /api/contacts`, PUT
 * `/api/contacts/[id]`); state, zip code and custom specialty have no form cap,
 * so they take the nearest sibling's. The columns are unbounded TEXT and are
 * mirrored to the marketing table, so a CSV must not be the one door around
 * the limits.
 */
export const IMPORT_MAX_LENGTH = {
  organization: 255, jobTitle: 255, specialty: 255, bio: 5000, phone: 50, notes: 2000,
  additionalEmail: 255, customSpecialty: 255, registrationType: 255,
  city: 255, state: 255, zipCode: 20, country: 255,
  associationName: 255, memberId: 100, studentId: 100,
} as const;
export type ImportCappedColumn = keyof typeof IMPORT_MAX_LENGTH;

/** Name and email caps, from the same forms. A longer one fails its row. */
export const IMPORT_REQUIRED_MAX = { firstName: 100, lastName: 100, email: 255 } as const;
