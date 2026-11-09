import crypto from "crypto";
import { db } from "./db";
import { apiLogger } from "./logger";
import { checkRateLimit, hashVerificationToken } from "./security";
import { sendEmail, emailTemplates, type EmailConfirmationPurpose } from "./email";

/**
 * Email confirmation links. Several uses share one token flow (`/verify-email`):
 * a Meeting Minds address joining the team (below); since Nov 5, 2026, any
 * account proving it owns its address so registrations made earlier under it
 * appear on My events (src/lib/registrant-access.ts) or a speaker profile can
 * be claimed; and an account made at /signup, which signs in only once
 * confirmed (src/lib/account-signup.ts).
 *
 * Email verification for VERIFIED internal domains (meetingmindsdubai.com).
 *
 * The gate is light by design (see [src/lib/internal-domains.ts]): a registrant
 * on a verified-internal domain is created org-null (a normal external
 * registrant) and sent a verify link. Clicking it marks them `emailVerified`
 * AND attaches the organization — that's the only thing verification unlocks.
 * Token identifier is `verify-email:{email}` (hashed token stored).
 */
export const EMAIL_VERIFY_PREFIX = "verify-email:";

/** The email log's label for each kind of confirmation. */
const CONFIRMATION_TEMPLATE_SLUG: Record<EmailConfirmationPurpose, string> = {
  team: "email-verification",
  registrations: "email-confirmation",
  speaker: "email-confirmation",
  account: "account-confirmation",
};
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Mint a verify-email token for `email` and send the verification email.
 * Best-effort: failures are logged, never thrown — registration must succeed
 * even if the verify email can't be sent (the link can be re-issued). Says
 * what happened, so a screen never claims a link was sent when it was not.
 */
export async function sendEmailVerification(params: {
  email: string;
  name: string;
  purpose?: EmailConfirmationPurpose;
}): Promise<"sent" | "rate-limited" | "failed"> {
  const { name, purpose = "team" } = params;
  // Lower-cased as verify-email reads it, or a mixed-case address gets a link
  // that can never match its token (security review of 7cf4eb3b).
  const email = params.email.trim().toLowerCase();
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
  // Per address, whoever triggers it: refused claims and registrations under
  // someone's address must not turn into a mail flood to them.
  const rl = checkRateLimit({ key: `email-confirmation-send:${email}`, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "email-verification:rate-limited", email, retryAfterSeconds: rl.retryAfterSeconds });
    return "rate-limited";
  }
  try {
    const identifier = `${EMAIL_VERIFY_PREFIX}${email}`;
    // Expired tokens only: deleting live ones would let anyone who registers
    // under someone's address cancel the link that person is about to click.
    await db.verificationToken.deleteMany({ where: { identifier, expires: { lt: new Date() } } });

    const rawToken = crypto.randomBytes(32).toString("hex");
    await db.verificationToken.create({
      data: {
        identifier,
        token: hashVerificationToken(rawToken),
        expires: new Date(Date.now() + VERIFY_TTL_MS),
      },
    });

    const verifyLink = `${appUrl}/verify-email?token=${rawToken}&email=${encodeURIComponent(email)}`;
    const tpl = emailTemplates.emailVerification({
      recipientName: name,
      verifyLink,
      expiresIn: "7 days",
      purpose,
    });

    const result = await sendEmail({
      to: [{ email, name }],
      subject: tpl.subject,
      htmlContent: tpl.htmlContent,
      textContent: tpl.textContent,
      emailType: "email_verification",
      stream: "transactional",
      logContext: { entityType: "USER", templateSlug: CONFIRMATION_TEMPLATE_SLUG[purpose] },
    });

    if (!result.success) {
      apiLogger.warn({ msg: "email-verification:send-failed", email, error: result.error });
      return "failed";
    }
    apiLogger.info({ msg: "email-verification:sent", email });
    return "sent";
  } catch (err) {
    apiLogger.error({ err, msg: "email-verification:mint-or-send-failed", email });
    return "failed";
  }
}
