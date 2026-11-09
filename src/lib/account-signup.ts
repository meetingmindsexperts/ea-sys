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
 * confirmed: a registrant account that has never proven its address and has
 * nothing of its own yet (no registration, no speaker record). That is an
 * account made at /signup, or one whose registrations were all removed.
 * Everything else signs in as before: an account made on a registration form
 * owns that registration, and staff, reviewers and submitters are untouched.
 *
 * Reads registrations without a tenant lane (sign-in has none yet). On master
 * that is the plain read; on the platform instance, where Registration is
 * policied, an unlaned read finds nothing and the account is asked to confirm,
 * which fails toward the extra step, never toward access.
 */
export async function signInNeedsConfirmation(user: {
  id: string;
  role: UserRole;
  emailConfirmedAt: Date | null;
}): Promise<boolean> {
  if (user.role !== "REGISTRANT" || user.emailConfirmedAt) return false;
  const [registration, speaker] = await Promise.all([
    db.registration.findFirst({ where: { userId: user.id }, select: { id: true } }),
    db.speaker.findFirst({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return !registration && !speaker;
}
