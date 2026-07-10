/**
 * CSV cell escaping with formula-injection neutralization — the single helper
 * every CSV export path must use (July 10, 2026 review H2).
 *
 * Quote-doubling alone is NOT enough: Excel / Google Sheets / LibreOffice
 * evaluate any cell whose first character is `=`, `+`, `-`, `@`, tab or CR as
 * a formula — the surrounding quotes are CSV delimiters, not cell content. A
 * registrant who sets their name to `=HYPERLINK(...)` or a DDE payload gets it
 * executed on the organizer's machine when the export is opened.
 *
 * Neutralization: prefix a `'` (Excel's literal-text marker) when the cell
 * starts with a dangerous character. Exception: `+`/`-` cells that are purely
 * phone/number-shaped (digits, spaces, `().-/`) are left untouched — they
 * cannot invoke a function or DDE (no letters/pipe/bang), and prefixing them
 * would corrupt phone numbers like `+971 4 555 0123` on export→import
 * round-trips. `=`, `@`, tab and CR prefixes are always neutralized.
 *
 * Client-safe: pure string logic, no Node imports.
 */

/** `+`/`-`-prefixed cells that are just numbers/phones — harmless, keep as-is. */
const BENIGN_NUMERIC = /^[+-][\d\s()./-]*$/;

/** Escape one CSV cell: neutralize formula prefixes, then RFC 4180-quote. */
export function escapeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const first = s.charAt(0);
  const dangerous =
    first === "=" || first === "@" || first === "\t" || first === "\r" ||
    ((first === "+" || first === "-") && !BENIGN_NUMERIC.test(s));
  const body = dangerous ? `'${s}` : s;
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

/** Join one row of cells through `escapeCsvCell`. */
export function toCsvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCsvCell).join(",");
}

/** Build a full CSV document (rows include the header row). */
export function toCsv(rows: readonly (readonly unknown[])[], eol = "\n"): string {
  return rows.map(toCsvRow).join(eol);
}
