import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { findUserByEmail } from "@/lib/tenant/user-lookup";
import { apiLogger } from "@/lib/logger";
import { isTrustedInternalEmail, needsEmailVerification } from "@/lib/internal-domains";
import { sendEmailVerification } from "@/lib/email-verification";
import { notifyEventAdmins } from "@/lib/notifications";
import { hasUnclaimedRegistrations, linkConfirmedRegistrations } from "@/lib/registrant-access";

/**
 * Create-or-link the REGISTRANT account behind a public registration. The
 * account owns THIS registration at once. Other unlinked registrations on the
 * same email join it only when the account has proven it owns the address
 * (User.emailConfirmedAt, src/lib/registrant-access.ts); until then it is sent
 * a confirmation link. Nov 5, 2026: before, they were swept in on the spot, so
 * registering with someone else's address showed their earlier registrations.
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
 * (guest registration with no account), unless `withoutPassword` is set: the
 * desk QR (docs/ONSITE_DESK_PLAN.md §8.3) makes the account with a random
 * password nobody knows, as reviewer invites do, and the person sets their own
 * through Forgot password.
 */
/** What happened, so the desk QR's email offers "set a password" only to an account it just made. */
export type RegistrantAccountOutcome = "none" | "linked" | "created" | "created-without-password" | "failed";

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
  /** Make the account even with no password (the desk QR). */
  withoutPassword?: boolean;
  /**
   * Link to an existing account only, never make one: the caller is linking a
   * signed-in person, and a miss means their account is not this email any
   * more, which must not become a second account behind their back.
   */
  linkOnly?: boolean;
  specialty: string | null;
  clientIp: string | null;
  /** Notification body — each caller keeps its own wording. */
  signupMessage: string;
}): Promise<RegistrantAccountOutcome> {
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
    withoutPassword,
    linkOnly,
  } = args;

  if (!password && !withoutPassword) return "none";

  try {
    // Tenant-scoped: linking a registration to an account found by email ALONE
    // would, on the platform, attach one tenant's registration to another
    // tenant's user (docs/PLATFORM_DECISIONS.md §6). On master this is a no-op
    // — one org, and every external account is org-null, so the org-less half
    // of the scope finds exactly what the global lookup found.
    const existingUser = await findUserByEmail({ organizationId }, email, {
      select: { id: true, role: true, termsAcceptedAt: true, emailConfirmedAt: true },
    });

    if (existingUser) {
      // Link this registration to the existing account; the others on this
      // address only if the account has proven it owns it (inside the caller's
      // tenant lane, so on the platform the set is tenant-local).
      await db.registration.update({
        where: { id: registrationId },
        data: { userId: existingUser.id },
      });
      await claimOrConfirm({ userId: existingUser.id, email, confirmed: !!existingUser.emailConfirmedAt }, `${firstName} ${lastName}`);
      // Record terms acceptance (first time only — never overwrite).
      if (!existingUser.termsAcceptedAt) {
        await db.user.update({
          where: { id: existingUser.id },
          data: { termsAcceptedAt: new Date(), termsAcceptedIp: clientIp },
        });
      }
      return "linked";
    } else if (linkOnly) {
      apiLogger.warn({ msg: "registrant-account:link-only-no-account", registrationId, eventId });
      return "none";
    } else {
      const passwordHash = await bcrypt.hash(password ?? crypto.randomBytes(32).toString("hex"), 10);
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
      // This registration only. A new account has proven nothing, so the
      // others on this address wait for the confirmation link.
      await db.registration.update({ where: { id: registrationId }, data: { userId: newUser.id } });
      // Verified-internal domain (real mailbox) → send a verify link; the org
      // attaches when they click it, and it also confirms the address.
      // Best-effort (won't fail signup).
      if (needsEmailVerification(email)) {
        void sendEmailVerification({ email, name: `${firstName} ${lastName}` });
      } else {
        await claimOrConfirm({ userId: newUser.id, email, confirmed: false }, `${firstName} ${lastName}`);
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
      return password ? "created" : "created-without-password";
    }
  } catch (err) {
    // Account creation failure must not block the registration.
    apiLogger.error({ err, msg: "registrant-account:create-or-link-failed", registrationId, eventId });
    return "failed";
  }
}

/**
 * A confirmed account takes the other unlinked registrations on its address;
 * an unconfirmed one is sent a confirmation link, but only when there is
 * something to claim, so most registrants never get an extra email.
 */
async function claimOrConfirm(scope: { userId: string; email: string; confirmed: boolean }, name: string): Promise<void> {
  if (scope.confirmed) {
    await linkConfirmedRegistrations(scope);
    return;
  }
  if (!(await hasUnclaimedRegistrations(scope))) return;
  apiLogger.info({ msg: "registrant-account:confirmation-requested", userId: scope.userId });
  void sendEmailVerification({ email: scope.email, name, purpose: "registrations" });
}
