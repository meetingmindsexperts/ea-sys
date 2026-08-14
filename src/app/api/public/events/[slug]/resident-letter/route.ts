/**
 * DEPRECATED shim, added Aug 14 2026. REMOVE after ~1 week (see below).
 *
 * The upload endpoint moved to `../supporting-document` on Aug 13 when the
 * Resident-only letter was generalised. Renaming a route that a PUBLIC page
 * posts to is not a server-side-only change: a registrant who loaded the
 * registration form before the deploy holds the old JS bundle, and their
 * upload POSTs here. Without this file they get a 404 surfaced as "Could not
 * upload the file", and on a type marked Required they cannot register at all
 * until they hard-refresh — which nothing tells them to do.
 *
 * Delegating rather than duplicating: same handler, same auth, same limits, so
 * the two paths cannot drift while both are live.
 *
 * SAFE TO DELETE once no `public/register:legacy-document-field-used` warnings
 * have appeared for a few days (that log line is the other half of the same
 * skew window and is the cheaper signal to watch).
 */
export { POST } from "../supporting-document/route";
