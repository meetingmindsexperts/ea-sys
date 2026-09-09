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
 * Email types whose audience must never include a CANCELLED registration.
 * The exclusion is UNCONDITIONAL (A6, July 16, 2026 — owner decision): the
 * where-clause guard below covers the no-explicit-status default, and
 * `precheckBulkEmailViability` rejects an explicit CANCELLED status filter for
 * these types with INVALID_FILTER (any other explicit status excludes
 * cancelled rows by itself). Before A6 only `certificate` had the explicit-
 * filter rejection — the "Cancelled Re-engagement" tile was 2 clicks from
 * dunning/surveying cancelled registrants.
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

/**
 * Should this send exclude GROUP-registration members? (Review H2, Aug 6 2026.)
 *
 * A group member's fee is owed by the COMPANY on the consolidated invoice —
 * the members-are-never-dunned contract of the group feature. The
 * payment-reminder audience must therefore never include a `groupId` row:
 * "Chase Unpaid" would otherwise individually ask 50 group members to pay
 * money their company already owes (each with a Pay Now link the checkout
 * route refuses anyway). UNCONDITIONAL for payment-reminder — there is no
 * legitimate individual dunning of a group member; the payer is chased via
 * the group invoice.
 */
export function excludesGroupMembers(emailType: string | undefined): boolean {
  return emailType === "payment-reminder";
}

// ───────────────────────── Abstract email types ─────────────────────────
// The status scope each abstract type applies, shared by the server's
// recipient resolver AND the dialog's picker/count, for the same reason as the
// registration rules above: the number the organiser reads must be the number
// we mail. Type-only Prisma import, so this stays client-safe.

import type { AbstractStatus } from "@prisma/client";

/** Types that send one email per ABSTRACT (the rest go once per author). */
export const PER_ABSTRACT_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "abstract-confirmation",
  "abstract-decision",
]);
/** Statuses a decision email can describe (the template heading comes from the status). */
export const ABSTRACT_DECISION_STATUSES = ["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"] as const;
/** Mirrors the single resend route's NOT_RESENDABLE set. */
export const ABSTRACT_NOT_RESENDABLE_STATUSES = ["DRAFT", "WITHDRAWN"] as const;
/**
 * Statuses a "submit your abstract" reminder may target (review M3, Sep 9,
 * 2026): authors who still have something to submit. The default scope is
 * DRAFT; REVISION_REQUESTED is an explicit choice for "please resubmit".
 */
export const ABSTRACT_REMINDER_STATUSES = ["DRAFT", "REVISION_REQUESTED"] as const;

/**
 * The status scope an abstract type applies when the organiser sets none:
 * a confirmation resend skips drafts and withdrawals, a decision resend
 * takes only decided abstracts, a reminder goes to authors still in DRAFT.
 * An explicit status filter overrides it (validated by
 * assertAbstractTypeStatus so it cannot contradict the type).
 */
export function defaultAbstractStatusFilter(
  emailType: string,
): AbstractStatus | { in: AbstractStatus[] } | { notIn: AbstractStatus[] } | undefined {
  if (emailType === "abstract-confirmation") return { notIn: [...ABSTRACT_NOT_RESENDABLE_STATUSES] };
  if (emailType === "abstract-decision") return { in: [...ABSTRACT_DECISION_STATUSES] };
  if (emailType === "abstract-reminder") return "DRAFT";
  return undefined;
}

/**
 * Would the server accept this explicit status for this type? The dialog only
 * OFFERS statuses this returns true for, and the server refuses the rest with
 * INVALID_FILTER; one predicate so the two cannot disagree.
 */
export function abstractStatusAllowedForType(emailType: string, status: string): boolean {
  if (emailType === "abstract-confirmation") {
    return !(ABSTRACT_NOT_RESENDABLE_STATUSES as readonly string[]).includes(status);
  }
  if (emailType === "abstract-decision") {
    return (ABSTRACT_DECISION_STATUSES as readonly string[]).includes(status);
  }
  if (emailType === "abstract-reminder") {
    return (ABSTRACT_REMINDER_STATUSES as readonly string[]).includes(status);
  }
  return true;
}

/**
 * Is an abstract with this status in the audience of this type, given the
 * organiser's explicit status filter (or "all" / undefined for the type's
 * default scope)? The client-side twin of the resolver's `where`.
 */
export function abstractInSendScope(
  abstractStatus: string,
  emailType: string,
  explicitStatus: string | undefined,
): boolean {
  if (explicitStatus && explicitStatus !== "all") return abstractStatus === explicitStatus;
  const scope = defaultAbstractStatusFilter(emailType);
  if (!scope) return true;
  if (typeof scope === "string") return abstractStatus === scope;
  if ("in" in scope) return (scope.in as string[]).includes(abstractStatus);
  return !(scope.notIn as string[]).includes(abstractStatus);
}
