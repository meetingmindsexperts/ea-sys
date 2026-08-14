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
 *
 * This list is for routes that post a large body as JSON (the CRM importers
 * send the whole CSV as a string). FILE uploads are handled by the multipart
 * rule below instead, because a path list cannot keep up with them.
 */
export const LARGE_BODY_PREFIXES = ["/api/crm/import/"] as const;

/**
 * Ceiling for `multipart/form-data` — i.e. every file upload.
 *
 * ⚠ THE BUG THIS FIXES (Aug 14, 2026). Until now every upload route inherited
 * the 1MB JSON default, silently, while advertising its own much larger cap in
 * its code, its error message, its organizer help text and the user guide.
 * Nineteen routes read `formData()`; the documented caps included 10MB for
 * certificate background PDFs ("full-res PNG cert designs commonly land at
 * 5-8MB" — that bump never took effect), 10MB for reimbursement and speaker
 * documents, 5MB for the registration supporting document, and 2MB for media.
 * All of them actually got 1MB. The registrant or organizer saw a bare
 * "Request body too large" with no hint of the real number.
 *
 * WHY A CONTENT-TYPE RULE RATHER THAN MORE PREFIXES. This module's own header
 * says the thing that goes wrong here is "a PREFIX drifting out of the list",
 * and the fix for the CRM importers proves it: that entry was added only after
 * an operator hit a bare 413, and it fixed exactly one family while eighteen
 * other routes stayed broken. A list keyed on paths has to be maintained by
 * whoever adds the next upload route, which is precisely the step that keeps
 * being missed. `multipart/form-data` IS the signal, needs no maintenance, and
 * a new upload route is correct on the day it is written.
 *
 * WHAT THIS DOES NOT WEAKEN. nginx already allows 10MB on EVERY route
 * (`client_max_body_size`), so the middleware was never the real bound — as
 * the note above says, treat these values as a courtesy limit that produces a
 * friendly 413, not as a security control. Each upload route still enforces
 * its own precise cap with a message naming the real number, and does so after
 * its own auth and rate limit. This raises the coarse ceiling to match nginx
 * so the ROUTE's better error is the one the user sees.
 */
export const UPLOAD_BODY_SIZE = 10 * 1_048_576 + 524_288; // 10MB + multipart overhead

/** Is this request a file upload (rather than a JSON body)? */
export function isMultipartUpload(contentType: string | null | undefined): boolean {
  // Header is `multipart/form-data; boundary=...`, and the type is
  // case-insensitive per RFC 9110.
  return (contentType ?? "").toLowerCase().trimStart().startsWith("multipart/form-data");
}

/**
 * The body-size ceiling that applies to a given request.
 *
 * `contentType` is optional so an existing caller passing only a path keeps
 * the old JSON behaviour rather than silently getting the upload allowance.
 */
export function maxBodySizeFor(pathname: string, contentType?: string | null): number {
  if (isMultipartUpload(contentType)) return UPLOAD_BODY_SIZE;
  return LARGE_BODY_PREFIXES.some((p) => pathname.startsWith(p)) ? IMPORT_BODY_SIZE : MAX_BODY_SIZE;
}
