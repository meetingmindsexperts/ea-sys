/**
 * Client-safe role predicate for hiding general management write controls in
 * the UI, so a non-writer never clicks a button that the API will 403.
 *
 * Mirrors the server-side `denyReviewer` boundary for general (non-desk,
 * non-abstract-review) writes: only SUPER_ADMIN / ADMIN / ORGANIZER may write.
 * Fails closed — an unknown / missing role gets `false`.
 *
 * IMPORTANT — two roles are deliberately NOT covered here:
 *   • MEMBER  — org-bound READ-ONLY viewer. Returns false (the whole point:
 *     MEMBER must not see general write buttons that 403).
 *   • ONSITE / MEMBER registration-desk — they ARE opted back in for a narrow
 *     set (add registration / check-in / badge print) via
 *     `REGISTRATION_DESK_ALLOW`. Those surfaces gate on their own role checks
 *     (isOnsite / isDeskOperator), NOT this helper. Don't use `canWrite` to
 *     gate the registration-desk actions or you'll wrongly hide them.
 *
 * This is intentionally a tiny pure module (no server imports) so it can be
 * used directly in `"use client"` components.
 */
export function canWrite(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN" || role === "ORGANIZER";
}
