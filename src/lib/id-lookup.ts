/**
 * ID LOOKUP — turn an opaque id from a log line back into a human name.
 *
 * WHY THIS EXISTS. Log lines carry ids, not names: `{"eventId":"cmt8fkgbl…"}`
 * tells an operator which row was involved and nothing about which event it
 * was. Answering "whose registration is cmxyz…?" meant a psql session, and
 * `prod:psql` is read-only-by-courtesy, so the cheap question had an expensive
 * answer. This module is the pure half of the answer: given pasted text, work
 * out which ids are in it. The resolving half lives in the route
 * (src/app/api/admin/lookup/route.ts) because it needs the privileged
 * cross-tenant lane and must stay behind the operator RBAC wall.
 *
 * The pure/impure split is deliberate: extraction is where the fiddly rules
 * live (paste a whole JSON line vs type one id vs paste prose), so it is the
 * part worth unit-testing, and it must not drag `db` into the test.
 */

/**
 * A cuid as Prisma mints it — 'c' followed by lowercase alphanumerics. The
 * length is a RANGE rather than the exact 24 because cuid2 and hand-written
 * fixtures differ, and a too-strict pattern fails silently: the id is simply
 * not offered for lookup and the operator concludes the tool is broken.
 */
const CUID_RE = /\bc[a-z0-9]{20,32}\b/g;

/**
 * Cap on ids resolved per request. A log line rarely carries more than three;
 * the cap exists so a pasted 200-line log dump cannot turn one click into
 * hundreds of `IN (…)` members. Extraction order is preserved, so the ids the
 * operator most likely cared about (the ones nearest the front of the line)
 * are the ones that survive the cut.
 */
export const MAX_LOOKUP_IDS = 8;

/** One row that matched an id, described for a human. */
export interface LookupHit {
  /** Model name, e.g. "Event", "Registration". */
  kind: string;
  id: string;
  /** The human name: event name, person's name, session title. */
  title: string;
  /** Supporting detail: status, serial, dates. Never PII beyond the title. */
  subtitle?: string;
  eventId?: string | null;
  organizationId?: string | null;
  /** Dashboard deep link, when the row has a page of its own. */
  href?: string | null;
  /** Filled in by the route from the parent Event / Organization. */
  eventName?: string | null;
  organizationName?: string | null;
}

/** Every hit for one submitted id. `hits` is empty when nothing matched. */
export interface LookupResult {
  id: string;
  hits: LookupHit[];
}

/**
 * Pull the id candidates out of whatever the operator pasted.
 *
 * Three shapes, in priority order:
 *   1. Text containing cuids (a whole log line, a JSON blob) → every cuid in
 *      it, de-duplicated, in order. This is the common case and the reason the
 *      box accepts a paste rather than a single field: copying the whole line
 *      is one action, picking the id out of it by hand is several.
 *   2. A single OPAQUE TOKEN with no cuid shape (a Stripe `pi_…`, an invoice
 *      number) → tried as-is. It will usually miss, and a clean miss is a
 *      better answer than refusing to look. "Opaque token" and not just "no
 *      whitespace": compact JSON has no whitespace either.
 *   3. Anything else (prose, an empty box, a paste with no ids) → nothing.
 *      Deliberately NOT "send the whole paste as one id": that turns a
 *      no-ids-here result into an unbounded string in a database query.
 */
export function extractIdCandidates(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const matches = trimmed.match(CUID_RE) ?? [];
  // The fallback accepts only an OPAQUE-TOKEN shape, not merely "no spaces":
  // a compact JSON line has no spaces either, and treating it as an id would
  // put an arbitrary blob into a database query. Letters, digits, `_` and `-`
  // still cover the real non-cuid cases (a Stripe `pi_…`, an invoice number).
  const source =
    matches.length > 0
      ? matches
      : /^[A-Za-z0-9_-]{1,64}$/.test(trimmed)
        ? [trimmed]
        : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of source) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= MAX_LOOKUP_IDS) break;
  }
  return out;
}
