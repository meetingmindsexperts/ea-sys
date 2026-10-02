/**
 * Update-or-create for CSV imports (Oct 2, 2026). When an imported row's
 * email already exists on the event, the row UPDATES that person instead of
 * being skipped, so re-importing the same file is safe and gives the same
 * result (idempotent).
 *
 * Owner rules:
 *  - an EMPTY cell keeps the existing value (a sparse file never wipes data;
 *    clearing a field stays a manual edit);
 *  - tags are ADDED to the existing ones, never replaced;
 *  - only fields that actually differ are written, so an unchanged row writes
 *    nothing and leaves no audit noise.
 * Pure: no database access. The import routes apply the patch through the
 * same services a manual edit uses (updateSpeaker / updateRegistration).
 */

export type ImportScalar = string | null | undefined;

export interface ImportPatch<K extends string> {
  /** Only the fields to change; absent keys are left alone. */
  patch: Partial<Record<K, string>> & { tags?: string[] };
  /** Human labels of what changed, for the import result. */
  changed: string[];
}

const norm = (v: ImportScalar): string => (v ?? "").trim();

/**
 * Compare a CSV row with the stored record. `incoming` holds the parsed cell
 * values (undefined or "" for an empty cell); `labels` names each field for
 * the result ("jobTitle" -> "job title").
 */
export function buildImportPatch<K extends string>(
  existing: Partial<Record<K, ImportScalar>> & { tags?: string[] | null },
  incoming: Partial<Record<K, ImportScalar>> & { tags?: string[] },
  labels: Record<K, string>,
): ImportPatch<K> {
  const patch: ImportPatch<K>["patch"] = {};
  const changed: string[] = [];

  for (const key of Object.keys(labels) as K[]) {
    const next = norm(incoming[key]);
    if (!next) continue; // empty cell: keep what is there
    if (next === norm(existing[key])) continue;
    (patch as Record<string, string>)[key] = next;
    changed.push(labels[key]);
  }

  const current = existing.tags ?? [];
  const lower = new Set(current.map((t) => t.toLowerCase()));
  const added = (incoming.tags ?? []).filter((t) => t.trim() && !lower.has(t.trim().toLowerCase()));
  if (added.length > 0) {
    patch.tags = [...current, ...added.map((t) => t.trim())];
    changed.push(`tags (+${added.join(", ")})`);
  }

  return { patch, changed };
}

/** "Row 7: jane@x.com updated (job title, bio)" */
export function updatedRowMessage(rowNum: number, email: string, changed: string[]): string {
  return `Row ${rowNum}: ${email} updated (${changed.join(", ")})`;
}
