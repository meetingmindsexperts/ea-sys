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
 * 8MB keeps headroom under nginx.
 *
 * ⚠ WHAT THIS DOES AND DOES NOT BOUND — an earlier version of this comment
 * claimed the routes were "admin-gated", which is false: they call
 * `requireCrmWrite`, which admits ORGANIZER and CRM_USER. What actually bounds
 * them is the 20/hr/org import rate limit and the CSV parser's 5,000-row cap,
 * and the row cap applies AFTER `req.json()`, so it bounds DB work rather than
 * parse cost.
 *
 * The size check itself only binds well-behaved clients: it reads
 * `content-length`, so a request using `Transfer-Encoding: chunked` skips it
 * entirely. The real ceiling on every route is nginx's `client_max_body_size`
 * (10MB). Treat the values here as a courtesy limit that produces a friendly
 * 413, not as a security control.
 *
 * The allow-list stays narrow for the same reason it always did — each entry is
 * a path an anonymous request can make Node ingest 8MB on, since this check runs
 * before route auth.
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
