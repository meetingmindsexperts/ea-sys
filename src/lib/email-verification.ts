import crypto from "crypto";
import { db } from "./db";
import { apiLogger } from "./logger";
import { hashVerificationToken } from "./security";
import { sendEmail, emailTemplates } from "./email";

/**
 * Email verification for VERIFIED internal domains (meetingmindsdubai.com).
 *
 * The gate is light by design (see [src/lib/internal-domains.ts]): a registrant
 * on a verified-internal domain is created org-null (a normal external
 * registrant) and sent a verify link. Clicking it marks them `emailVerified`
 * AND attaches the organization — that's the only thing verification unlocks.
 * Token identifier is `verify-email:{email}` (hashed token stored).
 */
export const EMAIL_VERIFY_PREFIX = "verify-email:";
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Mint a verify-email token for `email` and send the verification email.
 * Best-effort: failures are logged, never thrown — registration must succeed
 * even if the verify email can't be sent (the link can be re-issued).
 */
export async function sendEmailVerification(params: { email: string; name: string }): Promise<void> {
  const { email, name } = params;
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
  try {
    const identifier = `${EMAIL_VERIFY_PREFIX}${email}`;
    // One live token per email — clear stale ones so a re-issue is unambiguous.
    await db.verificationToken.deleteMany({ where: { identifier } });

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
    });

    const result = await sendEmail({
      to: [{ email, name }],
      subject: tpl.subject,
      htmlContent: tpl.htmlContent,
      textContent: tpl.textContent,
      emailType: "email_verification",
      stream: "transactional",
      logContext: { entityType: "USER", templateSlug: "email-verification" },
    });

    if (!result.success) {
      apiLogger.warn({ msg: "email-verification:send-failed", email, error: result.error });
    } else {
      apiLogger.info({ msg: "email-verification:sent", email });
    }
  } catch (err) {
    apiLogger.error({ err, msg: "email-verification:mint-or-send-failed", email });
  }
}
