import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isTrustedInternalEmail, needsEmailVerification } from "@/lib/internal-domains";
import { sendEmailVerification } from "@/lib/email-verification";
import { notifyEventAdmins } from "@/lib/notifications";

/**
 * Create-or-link the REGISTRANT account behind a public registration, then link
 * every unlinked registration on the same email to it.
 *
 * Shared by the public `register` route and the token-gated
 * `complete-registration` route — the two carried byte-identical ~60-line copies
 * (existingUser → link this reg + sweep siblings + first-time terms stamp; else
 * create a REGISTRANT + internal-domain org-attach + verify-email link + admin
 * SIGNUP notification).
 *
 * FAILURE-ISOLATED by contract: account creation must never block the
 * registration itself, so the whole body is wrapped in try/catch and a failure
 * is logged at error level and swallowed. No-ops when `password` is absent
 * (guest registration with no account).
 */
export async function ensureRegistrantAccount(args: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  /** Already lowercased by the caller. */
  email: string;
  firstName: string;
  lastName: string;
  /** When absent, this is a guest registration — no account is created. */
  password: string | undefined;
  specialty: string | null;
  clientIp: string | null;
  /** Notification body — each caller keeps its own wording. */
  signupMessage: string;
}): Promise<void> {
  const {
    registrationId,
    eventId,
    organizationId,
    email,
    firstName,
    lastName,
    password,
    specialty,
    clientIp,
    signupMessage,
  } = args;

  if (!password) return;

  try {
    const existingUser = await db.user.findUnique({
      where: { email },
      select: { id: true, role: true, termsAcceptedAt: true },
    });

    if (existingUser) {
      // Link this registration to the existing account, then sweep any other
      // unlinked registrations on the same email.
      await db.registration.update({
        where: { id: registrationId },
        data: { userId: existingUser.id },
      });
      await db.registration.updateMany({
        where: { attendee: { email }, userId: null },
        data: { userId: existingUser.id },
      });
      // Record terms acceptance (first time only — never overwrite).
      if (!existingUser.termsAcceptedAt) {
        await db.user.update({
          where: { id: existingUser.id },
          data: { termsAcceptedAt: new Date(), termsAcceptedIp: clientIp },
        });
      }
    } else {
      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = await db.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: "REGISTRANT",
          // TRUSTED internal domains (temp accounts) belong to the org from the
          // start. VERIFIED internal domains (meetingmindsdubai.com) stay
          // org-null until they verify (link sent below). External attendees
          // stay org-independent.
          organizationId: isTrustedInternalEmail(email) ? organizationId : null,
          specialty,
          termsAcceptedAt: new Date(),
          termsAcceptedIp: clientIp,
        },
      });
      // Link this registration + any other unlinked registrations by this email.
      await db.registration.updateMany({
        where: { attendee: { email }, userId: null },
        data: { userId: newUser.id },
      });
      // Verified-internal domain (real mailbox) → send a verify link; the org
      // attaches when they click it. Best-effort (won't fail signup).
      if (needsEmailVerification(email)) {
        void sendEmailVerification({ email, name: `${firstName} ${lastName}` });
      }
      // Notify admins of the new signup (non-blocking).
      notifyEventAdmins(eventId, {
        type: "SIGNUP",
        title: "New Account Signup",
        message: signupMessage,
        link: `/events/${eventId}/registrations`,
      }).catch((err) =>
        apiLogger.warn({ err, msg: "registrant-account:notify-admins-failed", registrationId, eventId }),
      );
    }
  } catch (err) {
    // Account creation failure must not block the registration.
    apiLogger.error({ err, msg: "registrant-account:create-or-link-failed", registrationId, eventId });
  }
}
