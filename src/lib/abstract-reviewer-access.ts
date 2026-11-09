/**
 * Who may review an abstract: THE rule, shared by the portal feed, the review
 * page's read and the review service (Nov 9, 2026).
 *
 * Review rights follow the event's reviewer pool and the per-abstract
 * assignment, never `User.role`. Most reviewers are speakers already, so their
 * account is a SUBMITTER: production added one to a pool, emailed them twice
 * and then refused the review, because the sidebar and the submit route asked
 * for role REVIEWER.
 *
 * Nobody reviews their own abstract, whatever else they hold. "Own" matches the
 * linked account OR the address, because a speaker row is often unlinked. It
 * only ever takes rights away, so an address match is safe here (compare
 * src/lib/registrant-access.ts, where an address would grant access).
 *
 * The pool and the assignment count only once the account has proven its
 * address (`User.emailConfirmedAt`, set by the confirmation link or by accepting
 * an invitation). Anyone can create an account on any address through a public
 * form, so without this, an account squatting a professor's address would read
 * every abstract on the event the day an organiser added that professor. Staff
 * are org-bound and invited, so the rule asks only of the outside accounts.
 *
 * Client-safe: no database import.
 */
import type { Prisma } from "@prisma/client";

/**
 * The accounts that become a SUBMITTER when they author an abstract, after
 * proving the password. A REVIEWER can: reviewing no longer depends on the role
 * and carries on from My Reviews, while the event pages an author needs are a
 * SUBMITTER's, which see only their own abstracts. Staff stay what they are.
 */
export function becomesSubmitterToAuthor(role: string | null | undefined): boolean {
  return role === "REGISTRANT" || role === "REVIEWER";
}

/** Whether this account must still confirm its address before it may review. */
export function mustConfirmEmailToReview(user: { role?: string | null; emailConfirmedAt?: Date | null } | null | undefined): boolean {
  if (!user) return true;
  const outside = user.role === "REVIEWER" || user.role === "SUBMITTER" || user.role === "REGISTRANT";
  return outside && !user.emailConfirmedAt;
}

/** Identity the rule needs. A session user fits. */
export interface ReviewerIdentity {
  id: string;
  email?: string | null;
}

/** The statuses a review may be written against. A DRAFT is private; the rest are decided or dead. */
export const REVIEWABLE_ABSTRACT_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"] as const;

export function isOnReviewerPool(settings: unknown, userId: string): boolean {
  const ids = (settings as { reviewerUserIds?: unknown } | null)?.reviewerUserIds;
  return Array.isArray(ids) && ids.includes(userId);
}

export function isOwnAbstract(
  speaker: { userId?: string | null; email?: string | null } | null | undefined,
  user: ReviewerIdentity,
): boolean {
  if (!speaker) return false;
  if (speaker.userId && speaker.userId === user.id) return true;
  const a = speaker.email?.trim().toLowerCase();
  const b = user.email?.trim().toLowerCase();
  return !!a && a === b;
}

/**
 * The same "own" as a query: spread into an abstract `where` to leave them out.
 *
 * Written as positives on purpose. `NOT: { speaker: { OR: [...] } }` renders as
 * `NOT (userId = $1 OR email ILIKE $2)`, which is NULL for a speaker with no
 * linked account, so it silently dropped every such abstract from every feed.
 */
export function excludeOwnAbstracts(user: ReviewerIdentity): Prisma.AbstractWhereInput {
  const notMine: Prisma.SpeakerWhereInput[] = [{ OR: [{ userId: null }, { userId: { not: user.id } }] }];
  if (user.email) notMine.push({ NOT: { email: { equals: user.email.trim(), mode: "insensitive" } } });
  return { speaker: { AND: notMine } };
}
