import { formatSerialId } from "@/lib/registration-serial";

/** Minimal registration shape needed to resolve pasted identifiers. */
export interface ResolvableRegistration {
  id: string;
  serialId: number | null;
  attendee?: { email?: string | null } | null;
}

/**
 * Resolve a pasted blob of identifiers → registration ids, for the
 * "Select by IDs" bulk workflow (paste a CSV column, act on those rows).
 *
 * A token matches any of: the full id (cuid), the padded serial ("002"), the
 * raw serial ("2"), or the attendee email (case-insensitive). Tokens are split
 * on whitespace / commas / semicolons, trimmed, and de-duplicated. Matched ids
 * are returned de-duped + in first-seen order; tokens that matched nothing in
 * the supplied set come back in `unmatched`.
 */
export function resolvePastedIds(
  text: string,
  rows: ResolvableRegistration[],
): { matched: string[]; unmatched: string[] } {
  const tokens = Array.from(
    new Set(text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)),
  );

  const lookup = new Map<string, string>();
  for (const r of rows) {
    lookup.set(r.id, r.id);
    if (r.serialId != null) {
      lookup.set(formatSerialId(r.serialId), r.id); // "002"
      lookup.set(String(r.serialId), r.id); // "2"
    }
    const email = r.attendee?.email;
    if (email) lookup.set(email.toLowerCase(), r.id);
  }

  const matched: string[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    const id =
      lookup.get(tok) ??
      lookup.get(tok.toLowerCase()) ??
      (/^\d+$/.test(tok) ? lookup.get(tok.padStart(3, "0")) : undefined);
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        matched.push(id);
      }
    } else {
      unmatched.push(tok);
    }
  }
  return { matched, unmatched };
}
