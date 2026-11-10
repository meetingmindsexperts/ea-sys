import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { equalsIgnoringCase } from "@/lib/like-escape";

/**
 * Which registrations belong to a signed-in person (Nov 5, 2026;
 * docs/ACCOUNT_CONFIRMATION_PLAN.md). THE rule for My events and every
 * registrant self-service route; never write `attendee: { email }` into a
 * registrant query again.
 *
 *   - A registration LINKED to the account (`userId`) is theirs: made through
 *     the account, or linked after they proved the address.
 *   - An UNLINKED registration that only carries their email is theirs once
 *     the account has proven it owns that address (`User.emailConfirmedAt`,
 *     set solely by a link sent to it, opened while signed in to the account).
 *
 * WHY. The email on a registration is whatever was typed into a form. Before
 * this, anyone who registered with another person's address and a password got
 * an account that showed that person's earlier guest registrations, payments
 * and certificates. `emailVerified` cannot be the signal: public submitter
 * sign-up and admin-created accounts set it without any proof.
 */

export interface RegistrantScope {
  userId: string;
  /** The account's own address, from the database, lower-cased. */
  email: string;
  /** The account proved it owns `email`. */
  confirmed: boolean;
}

/**
 * How the caller knows this is the account's holder: a session (its revocation
 * counter, `session.user.tokenVersion`), or a password checked in this request.
 */
export type ScopeProof = { sessionTokenVersion: number | undefined } | "password-checked";

/**
 * The account's scope, read from the database (never from the session cookie).
 * A session a password reset or invitation revoked (its counter behind the
 * database's) gets the UNCONFIRMED view: such a session lives up to five more
 * minutes before its re-check, and it may be whoever made this account on
 * someone else's address (security review of dd21f2c9).
 */
export async function loadRegistrantScope(userId: string, proof: ScopeProof): Promise<RegistrantScope | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, emailConfirmedAt: true, tokenVersion: true } });
  if (!user) return null;
  const current = proof === "password-checked" || (proof.sessionTokenVersion ?? 0) === (user.tokenVersion ?? 0);
  return { userId, email: user.email.trim().toLowerCase(), confirmed: !!user.emailConfirmedAt && current };
}

/**
 * The registrations this person may see and act on. The address branch takes
 * only UNLINKED rows: one already linked to another account is that account's,
 * whatever email it carries.
 */
export function ownRegistrationWhere(scope: RegistrantScope): Prisma.RegistrationWhereInput {
  if (!scope.confirmed || !scope.email) return { userId: scope.userId };
  return { OR: [{ userId: scope.userId }, { userId: null, attendee: { email: equalsIgnoringCase(scope.email) } }] };
}

/**
 * Link the unlinked registrations carrying this address to the account, once
 * it is confirmed; a no-op otherwise. Returns how many were linked.
 */
export async function linkConfirmedRegistrations(scope: RegistrantScope): Promise<number> {
  if (!scope.confirmed || !scope.email) return 0;
  const { count } = await db.registration.updateMany({
    where: { userId: null, attendee: { email: equalsIgnoringCase(scope.email) } },
    data: { userId: scope.userId },
  });
  return count;
}

/**
 * This event already has a speaker record on the address that nobody has
 * claimed (the organisers made it), and the account has not proven the
 * address: the sign-up doors then change nothing and send a confirmation link
 * instead. Checked BEFORE any write, so a person who never confirms keeps
 * their account exactly as it was (security review of dd21f2c9).
 */
export async function speakerClaimPending(eventId: string, email: string, accountConfirmed: boolean): Promise<boolean> {
  if (accountConfirmed) return false;
  const speaker = await db.speaker.findFirst({
    where: { eventId, userId: null, email: equalsIgnoringCase(email) },
    select: { id: true },
  });
  return !!speaker;
}

/**
 * Claim the speaker records carrying this address that nobody has claimed
 * (the organisers added them), once the account is confirmed; a no-op
 * otherwise. Returns how many were claimed.
 */
export async function linkConfirmedSpeakers(scope: RegistrantScope, organizationId?: string | null): Promise<number> {
  if (!scope.confirmed || !scope.email) return 0;
  const { count } = await db.speaker.updateMany({
    // The host's organisation when there is one, on top of the tenant lane.
    where: { userId: null, email: equalsIgnoringCase(scope.email), ...(organizationId && { organizationId }) },
    data: { userId: scope.userId },
  });
  return count;
}

/**
 * Whether an unconfirmed account has registrations under its address that it
 * cannot see yet: the reason to send a confirmation link. Never shown to the
 * person as a count, which would tell an unproven account that the address
 * has history.
 */
export async function hasUnclaimedRegistrations(scope: RegistrantScope): Promise<boolean> {
  if (scope.confirmed || !scope.email) return false;
  const found = await db.registration.findFirst({
    // Spelled out with userId: null: `NOT { userId }` is SQL `<>`, which never matches a NULL.
    where: {
      OR: [{ userId: null }, { userId: { not: scope.userId } }],
      attendee: { email: equalsIgnoringCase(scope.email) },
    },
    select: { id: true },
  });
  return !!found;
}
