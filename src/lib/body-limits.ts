/**
 * Per-route request-body size limits.
 *
 * Lives in its own module rather than inline in `src/proxy.ts` so it can be unit
 * tested: the proxy imports NextAuth, which makes it awkward to exercise, and
 * the thing that actually goes wrong here is a PREFIX drifting out of the list
 * — a silent 413 on a route that is supposed to accept a large body.
 *
 * Client-safe by construction (no imports at all).
 */

/** The default for every JSON API route. */
export const MAX_BODY_SIZE = 1_048_576; // 1MB

/**
 * CSV imports post the whole file as a JSON string, so the 1MB default rejects a
 * perfectly ordinary export: ~5,000 Freshsales deal rows is 2-3MB, and the
 * operator saw a bare 413 with nothing to act on. nginx already allows 10MB
 * (`client_max_body_size`), so the app limit was the binding one.
 *
 * 8MB keeps headroom under nginx. Raising it is safe ONLY for these routes
 * because they are admin-gated, rate-limited (20/hr/org), and row-capped by the
 * CSV parser — none of which is true of the general API surface, which is why
 * this is a narrow allow-list and not a bumped default.
 */
export const IMPORT_BODY_SIZE = 8 * 1_048_576; // 8MB

/**
 * Route prefixes allowed the larger body. Keep this list SHORT and specific —
 * every entry is a route where an attacker can make us buffer 8MB.
 */
export const LARGE_BODY_PREFIXES = ["/api/crm/import/"] as const;

/** The body-size ceiling that applies to a given request path. */
export function maxBodySizeFor(pathname: string): number {
  return LARGE_BODY_PREFIXES.some((p) => pathname.startsWith(p)) ? IMPORT_BODY_SIZE : MAX_BODY_SIZE;
}
