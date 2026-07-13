/**
 * Bulk-email audience rules that BOTH the server and the client need.
 *
 * Client-safe by construction: pure predicates, no `db`, no Node built-ins —
 * the dashboard's recipient-count predicates are client components, and
 * `src/lib/bulk-email.ts` imports Prisma, so the rule cannot live there.
 * `bulk-email.ts` imports FROM here, never the other way round.
 *
 * Why it matters that there is exactly one definition: the recipient count the
 * organizer reads in the dialog and the audience the server actually mails are
 * computed by different code in different processes. If the rule is written out
 * twice, the count and the send drift, and the organizer is told they emailed
 * 200 people when they emailed 180 — or worse, the reverse.
 */

/**
 * Email types whose audience must never include a CANCELLED registration —
 * applied ONLY when the caller sets no explicit status filter. An explicit
 * status already scopes the send (and any non-CANCELLED value excludes them
 * anyway), so the guard exists to make the *default* safe, not to override a
 * deliberate choice.
 *
 * - `payment-reminder`  — a cancelled registration owes nothing; chasing it is
 *   a dunning email for a debt that does not exist.
 * - `certificate`       — mirrors the Issue-tab eligibility rule: a cancelled
 *   registration can never be issued a certificate.
 * - `survey-invitation` — the survey stamps `surveyCompletedAt`, which is the
 *   trigger for certificate auto-issue. Inviting a cancelled registrant would
 *   dangle a certificate the auto-issue sweep will then (correctly) refuse to
 *   mint, and asks "how was the event?" of someone who withdrew from it.
 */
export const CANCELLED_EXCLUDED_EMAIL_TYPES = [
  "payment-reminder",
  "certificate",
  "survey-invitation",
] as const;

/**
 * Should this send exclude CANCELLED registrations by default?
 *
 * `status` is the caller's explicit registration-status filter, if any. The
 * dashboard represents "no filter" as the sentinel `"all"`; the server
 * represents it as `undefined`. Both are accepted so the one predicate can back
 * the server `where` clause and the client-side counts without a translation
 * layer in between (a translation layer is a place for the two to disagree).
 */
export function excludesCancelledByDefault(
  emailType: string | undefined,
  status: string | undefined
): boolean {
  if (!emailType) return false;
  if (!(CANCELLED_EXCLUDED_EMAIL_TYPES as readonly string[]).includes(emailType)) return false;
  return !status || status === "all";
}
