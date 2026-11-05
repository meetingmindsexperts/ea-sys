import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

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

/** The account's scope, read from the database (never from the session cookie). */
export async function loadRegistrantScope(userId: string): Promise<RegistrantScope | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, emailConfirmedAt: true } });
  if (!user) return null;
  return { userId, email: user.email.trim().toLowerCase(), confirmed: !!user.emailConfirmedAt };
}

/**
 * The registrations this person may see and act on. The address branch takes
 * only UNLINKED rows: one already linked to another account is that account's,
 * whatever email it carries.
 */
export function ownRegistrationWhere(scope: RegistrantScope): Prisma.RegistrationWhereInput {
  if (!scope.confirmed || !scope.email) return { userId: scope.userId };
  return { OR: [{ userId: scope.userId }, { userId: null, attendee: { email: { equals: scope.email, mode: "insensitive" } } }] };
}

/**
 * Link the unlinked registrations carrying this address to the account, once
 * it is confirmed; a no-op otherwise. Returns how many were linked.
 */
export async function linkConfirmedRegistrations(scope: RegistrantScope): Promise<number> {
  if (!scope.confirmed || !scope.email) return 0;
  const { count } = await db.registration.updateMany({
    where: { userId: null, attendee: { email: { equals: scope.email, mode: "insensitive" } } },
    data: { userId: scope.userId },
  });
  return count;
}

/**
 * Claim the speaker records carrying this address that nobody has claimed
 * (the organisers added them), once the account is confirmed; a no-op
 * otherwise. Returns how many were claimed.
 */
export async function linkConfirmedSpeakers(scope: RegistrantScope): Promise<number> {
  if (!scope.confirmed || !scope.email) return 0;
  const { count } = await db.speaker.updateMany({
    where: { userId: null, email: { equals: scope.email, mode: "insensitive" } },
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
      attendee: { email: { equals: scope.email, mode: "insensitive" } },
    },
    select: { id: true },
  });
  return !!found;
}
