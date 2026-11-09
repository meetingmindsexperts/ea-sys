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
 * Client-safe: no database import.
 */
import type { Prisma } from "@prisma/client";

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

/** The same "own" as a query: spread into an abstract `where` to leave them out. */
export function excludeOwnAbstracts(user: ReviewerIdentity): Prisma.AbstractWhereInput {
  const own: Prisma.SpeakerWhereInput[] = [{ userId: user.id }];
  if (user.email) own.push({ email: { equals: user.email.trim(), mode: "insensitive" } });
  return { NOT: { speaker: { OR: own } } };
}
