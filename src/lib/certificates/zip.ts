/**
 * Zip-entry naming for the per-run "Download all certificates" export.
 * Pure (no I/O) so it's unit-testable; the streaming itself lives in the
 * download route.
 */

/**
 * Build a safe, unique zip entry filename for one cert PDF:
 * `"{serial} - {recipientName}.pdf"`.
 *
 * - Path separators, Windows-reserved characters, and control chars are
 *   stripped (a recipient name must never become a path inside the zip).
 * - Whitespace collapsed, length capped so exotic names can't blow up
 *   extractors with 300-char filenames.
 * - `taken` dedupes collisions with a ` (2)` style suffix (serials are
 *   globally unique so collisions are defensive, not expected).
 */
export function certZipEntryName(
  serial: string,
  recipientName: string | null | undefined,
  taken: Set<string>,
): string {
  const base =
    [serial, recipientName?.trim()]
      .filter(Boolean)
      .join(" - ")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "certificate";
  let name = `${base}.pdf`;
  let i = 2;
  while (taken.has(name)) name = `${base} (${i++}).pdf`;
  taken.add(name);
  return name;
}
