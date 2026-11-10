/**
 * Who may review an abstract: THE rule, shared by the portal feed, the review
 * page's read, the review service and the event's abstract routes (Nov 9, 2026).
 *
 * Review rights follow the per-abstract ASSIGNMENT, never `User.role`, and
 * never the event's reviewer pool alone (owner, Nov 10, 2026: "reviewer only
 * sees what they are assigned, not all abstracts"; on MEHF2027 six pool
 * members could read all 169 abstracts while two held one assignment each).
 * The pool is the list of people an organiser assigns from and emails, and it
 * still decides which events a REVIEWER account can open.
 *
 * Most reviewers are speakers already, so their account is a SUBMITTER:
 * production added one to a pool, emailed them twice and then refused the
 * review, because the sidebar and the submit route asked for role REVIEWER.
 *
 * Nobody reviews their own abstract, whatever else they hold. "Own" matches the
 * linked account OR the address, because a speaker row is often unlinked. It
 * only ever takes rights away, so an address match is safe here (compare
 * src/lib/registrant-access.ts, where an address would grant access).
 *
 * For a SUBMITTER or REGISTRANT, the pool and the assignment count only once the
 * address is proven (`User.emailConfirmedAt`, set by the confirmation link or by
 * accepting an invitation), and on a session that proof has not revoked. Anyone
 * can create those two kinds of account on any address through a public form, so
 * without this, an account squatting a professor's address would read every
 * abstract on the event the day an organiser added that professor. A REVIEWER is
 * not asked: no public door creates one, only an emailed invitation or an admin,
 * and accounts from before the column existed were never stamped. Staff are
 * org-bound and invited.
 *
 * Client-safe: no database import.
 */
import type { Prisma } from "@prisma/client";
import { equalsIgnoringCase } from "@/lib/like-escape";

/**
 * The accounts that become a SUBMITTER when they author an abstract, after
 * proving the password. A REVIEWER can: reviewing no longer depends on the role
 * and carries on from My Reviews, while the event pages an author needs are a
 * SUBMITTER's, which see only their own abstracts. Staff stay what they are.
 */
export function becomesSubmitterToAuthor(role: string | null | undefined): boolean {
  return role === "REGISTRANT" || role === "REVIEWER";
}

/**
 * Whether this account must still confirm its address before it may review.
 * `sessionTokenVersion` is the caller's session counter when there is a session:
 * accepting an invitation or resetting a password confirms the address and bumps
 * the counter together, and the session it revoked lives up to five more minutes,
 * which may be whoever made the account on someone else's address (the same rule
 * as loadRegistrantScope in registrant-access.ts).
 */
export function mustConfirmEmailToReview(
  user: { role?: string | null; emailConfirmedAt?: Date | null; tokenVersion?: number | null } | null | undefined,
  sessionTokenVersion?: number | null,
): boolean {
  if (!user) return true;
  if (user.role !== "SUBMITTER" && user.role !== "REGISTRANT") return false;
  if (!user.emailConfirmedAt) return true;
  return sessionTokenVersion !== undefined && (sessionTokenVersion ?? 0) !== (user.tokenVersion ?? 0);
}

/** Identity the rule needs. A session user fits. */
export interface ReviewerIdentity {
  id: string;
  email?: string | null;
}

/** The statuses a review may be written against. A DRAFT is private; the rest are decided or dead. */
export const REVIEWABLE_ABSTRACT_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "REVISION_REQUESTED"] as const;

/**
 * The abstracts assigned to this person: spread into an abstract `where`. A
 * conflict-flagged assignment still lists (the portal shows the flag); the
 * review service and the reviews route refuse it separately.
 */
export function assignedToReviewWhere(userId: string): Prisma.AbstractWhereInput {
  return { reviewers: { some: { userId } } };
}

/**
 * Which of an event's abstracts the two outside accounts reach on the event's
 * own abstract routes: a SUBMITTER their own, a REVIEWER the ones assigned to
 * them. Staff are scoped by their permissions, so nothing is added for them.
 */
export function linkedRoleAbstractFilter(user: { id: string; role?: string | null }): Prisma.AbstractWhereInput {
  if (user.role === "SUBMITTER") return { speaker: { userId: user.id } };
  if (user.role === "REVIEWER") return assignedToReviewWhere(user.id);
  // Any other outside account (a REGISTRANT, should a route ever let one in)
  // reaches nothing: fail closed rather than see the whole event.
  if (user.role === "REGISTRANT") return { id: { in: [] } };
  return {};
}

/**
 * THE rule for which assignments "Send assignments" would email right now:
 * not emailed yet, no declared conflict, and the abstract still up for review
 * on this event. The Reviewers page's "not emailed yet" count, the send
 * route's recipient list and the email itself all use it, so a count can never
 * show something a press would not send (review of 2df0f9e6: a conflict-flagged
 * or decided assignment kept the button forever). The send lease
 * (notifyClaimedAt) stays out on purpose: a row under a claim is still not
 * emailed.
 */
export function sendableAssignmentWhere(eventId: string): Prisma.AbstractReviewerWhereInput {
  return {
    notifiedAt: null,
    conflictFlag: false,
    abstract: { eventId, status: { in: [...REVIEWABLE_ABSTRACT_STATUSES] } },
  };
}

/** The ids on the event's reviewer pool; anything malformed is no pool. */
export function reviewerPoolIds(settings: unknown): string[] {
  const ids = (settings as { reviewerUserIds?: unknown } | null)?.reviewerUserIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** Pool membership: who can be assigned and emailed. It grants no abstract by itself. */
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
/**
 * Whether a reviewer's account can already sign in, so it needs no setup
 * invitation (owner, Nov 10, 2026).
 *
 * Only an account made BY INVITATION starts without a usable password, and it
 * gets `emailVerified` when the invitation is accepted. On a reviewer pool that
 * is a REVIEWER account (staff accounts are refused as reviewers). A REGISTRANT
 * or SUBMITTER account was made by its owner, with a password, and a registrant
 * usually has no `emailVerified` at all.
 *
 * Until this, `emailVerified` alone stood for "has a password": a registrant
 * added as a reviewer showed "Pending Invitation", Send assignments skipped
 * them, and Send invitation mailed a link that REPLACED their password. They
 * already see My Reviews in their portal once abstracts are assigned.
 * The Reviewers page, the assignment email and the invitation route all ask this.
 */
export function reviewerAccountIsSetUp(user: { role?: string | null; emailVerified?: Date | null } | null | undefined): boolean {
  if (!user) return false;
  if (user.emailVerified) return true;
  return user.role === "REGISTRANT" || user.role === "SUBMITTER";
}

export function excludeOwnAbstracts(user: ReviewerIdentity): Prisma.AbstractWhereInput {
  const notMine: Prisma.SpeakerWhereInput[] = [{ OR: [{ userId: null }, { userId: { not: user.id } }] }];
  if (user.email) notMine.push({ NOT: { email: equalsIgnoringCase(user.email.trim()) } });
  return { speaker: { AND: notMine } };
}
