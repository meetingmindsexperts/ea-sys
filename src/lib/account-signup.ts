import type { UserRole } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Creating an account on its own, without registering for an event (Nov 5,
 * 2026; phase 2 of docs/ACCOUNT_CONFIRMATION_PLAN.md). Owner ruling: signing
 * up for an account needs email confirmation; registering for an event does
 * not. So an account made at /signup cannot sign in until its address is
 * confirmed, while an account made on a registration form signs in at once.
 */

export { SIGNUP_PASSWORD_MIN, SIGNUP_PASSWORD_MAX } from "@/lib/account-signup-rules";

/** Accounts made at /signup and never confirmed are removed after this. */
export const UNCONFIRMED_ACCOUNT_RETENTION_DAYS = 30;

/**
 * Whether a correct password should still be refused until the address is
 * confirmed: a registrant account MADE AT /signup (AccountProfile.signedUpAt)
 * that has never proven its address. Owner ruling: signing up for an account
 * needs email confirmation; registering for an event does not.
 *
 * A positive marker, never "owns nothing" (portal review, Nov 9, 2026): a
 * group coordinator who is not attending owns no registration and no speaker
 * record, never received a confirmation link, and was locked out and then
 * pruned by the earlier inference. And AccountProfile has no RLS policy, so
 * the answer is the same on the platform, where an unlaned Registration read
 * finds nothing. Accounts made by registration forms, invitations and staff
 * have no signedUpAt and sign in as before.
 */
export async function signInNeedsConfirmation(user: {
  id: string;
  role: UserRole;
  emailConfirmedAt: Date | null;
}): Promise<boolean> {
  if (user.role !== "REGISTRANT" || user.emailConfirmedAt) return false;
  const profile = await db.accountProfile.findUnique({ where: { userId: user.id }, select: { signedUpAt: true } });
  return !!profile?.signedUpAt;
}
