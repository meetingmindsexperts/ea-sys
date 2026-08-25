/**
 * What to do when a background request comes back 401.
 *
 * THE BUG THIS EXISTS FOR. A dashboard or CRM tab left open past the 48h
 * session lifetime keeps rendering. Its React Query hooks all fire on the
 * next window focus, the server answers 401 to every one, and the page
 * renders EMPTY lists rather than sending the person to sign in. Production
 * logs caught a real person doing this three times across two days: fifteen
 * CRM routes 401'ing inside ninety seconds, then the same contact record
 * retried three minutes later. Nothing told them they were logged out, so it
 * read as a broken page rather than an expired one.
 *
 * A page LOAD was never affected — `(dashboard)/layout.tsx` calls `auth()`
 * and server-redirects to /login. Only the already-open tab breaks, because
 * client-side fetches never pass through that guard. So the fix belongs at
 * the one place every client query failure lands: `QueryCache.onError`.
 *
 * WHY THE STATUS READ IS STRUCTURAL, not `instanceof ApiError`. This app has
 * three fetchers that each shape their errors differently:
 *   - `src/lib/api-fetch.ts`      → `ApiError` (CRM, and mutations that branch on code)
 *   - `src/hooks/use-api.ts`      → also `ApiError` as of this change (the core dashboard)
 *   - `invoices-client.tsx`       → a hand-rolled `Error & { status }`
 * A check that recognises only one of them fixes one module and silently
 * misses the others, which is the precise failure this whole change is about.
 * Reading `.status` structurally covers all three and anything added later.
 */

/**
 * The HTTP status an error carries, if any. Returns undefined for network
 * failures, thrown strings, and anything else without a numeric `status`.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Where to send someone whose session has expired, or null to leave them
 * where they are.
 *
 * `search` is carried into the callback so filters and the open record
 * survive the round trip — the reported case was someone re-opening one
 * specific contact, and dropping them on an unfiltered list would repeat
 * the frustration in a different shape.
 */
export function buildLoginRedirect(pathname: string, search = ""): string | null {
  if (!pathname.startsWith("/")) return null;

  // The self-service check-in kiosk is ATTENDEE-facing and full-screen, and
  // its exit is PIN-gated precisely so attendees cannot leave that view.
  // Redirecting it would put a staff password box in front of a queue of
  // delegates on event morning. It already has its own "Kiosk needs
  // attention" state for exactly this case, driven by a raw fetch that never
  // reaches React Query. Never redirect it.
  if (pathname.includes("/kiosk")) return null;

  const here = `${pathname}${search}`;
  const segments = pathname.split("/").filter(Boolean);

  // Public event pages have their own branded login. Sending a registrant to
  // the staff sign-in would be a worse experience than the empty page.
  if (segments[0] === "e") {
    const slug = segments[1];
    if (!slug || segments[2] === "login") return null;
    return (
      `/e/${encodeURIComponent(slug)}/login` +
      `?redirect=${encodeURIComponent(here)}&reason=expired`
    );
  }

  // Only /login can loop. This started as a seven-entry list also covering
  // /register, /forgot-password, /reset-password, /accept-invitation,
  // /verify-email and /mcp-authorize — none of which can produce a React
  // Query 401 at all, because they are token-based or plain form posts and
  // make no client queries. Six entries of defence against nothing.
  if (pathname === "/login" || pathname.startsWith("/login/")) return null;

  return `/login?callbackUrl=${encodeURIComponent(here)}&reason=expired`;
}

/**
 * Latch. A stale tab produces a BURST of 401s (fifteen inside ninety seconds
 * in the observed case, because every hook on the page refetches at once).
 * Without this, each one would start its own navigation.
 */
let redirecting = false;

/** Test seam — module state would otherwise leak between cases. */
export function resetSessionExpiryLatch(): void {
  redirecting = false;
}

/**
 * Redirect to sign-in if this 401 warrants it. Returns whether it handled
 * the error, so the caller knows not to also report it as a fault.
 *
 * `location` and `navigate` are injected rather than read off `window` so
 * the decision is testable without a DOM.
 */
export function handleUnauthorized(
  location: { pathname: string; search: string },
  navigate: (url: string) => void,
): boolean {
  if (redirecting) return true;

  const target = buildLoginRedirect(location.pathname, location.search);
  if (!target) return false;

  redirecting = true;
  navigate(target);
  return true;
}

/**
 * Retry policy for background queries.
 *
 * An auth failure cannot succeed on retry, and retrying it doubles the burst
 * of failed requests a stale tab produces — the observed case was fifteen
 * routes failing inside ninety seconds, which a blind retry would have made
 * thirty. Everything else keeps the single retry the app has always had.
 *
 * `failureCount < 1` is exactly what `retry: 1` meant: query-core evaluates
 * shouldRetry BEFORE incrementing, so failureCount is 0 on the first failure.
 * Verified against @tanstack/query-core retryer.js rather than assumed.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status === 401 || status === 403) return false;
  return failureCount < 1;
}
