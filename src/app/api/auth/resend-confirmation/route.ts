import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { findUserByEmail, scopeFromRequestHost } from "@/lib/tenant/user-lookup";
import { sendEmailVerification } from "@/lib/email-verification";
import { signInNeedsConfirmation } from "@/lib/account-signup";

/**
 * "Send the link again" for an account made at /signup that is not confirmed
 * yet (Nov 5, 2026): the sign-in refusal and the check-your-email screen. The
 * person is signed out, so this takes an address.
 *
 * Same answer whatever the address: a link goes only to an account that sign-in
 * would refuse for want of confirmation, so this can neither tell anyone which
 * addresses have accounts nor be used to mail people who never signed up.
 * sendEmailVerification also caps links at 5 per address per hour.
 */

const schema = z.object({ email: z.string().trim().email().max(255) }).strict();

const ACCEPTED = { ok: true, message: "If that address has an account waiting for confirmation, we have sent the link again." };

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = checkRateLimit({ key: `resend-confirmation:ip:${ip}`, limit: 10, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "auth/resend-confirmation:rate-limited", ip });
      return NextResponse.json(
        { error: "Too many attempts. Please try again later.", retryAfterSeconds: rl.retryAfterSeconds, limit: 10, windowSeconds: 3600 },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      apiLogger.warn({ msg: "auth/resend-confirmation:validation-failed", errors: parsed.error.flatten().fieldErrors, ip });
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    const email = parsed.data.email.toLowerCase();

    const user = await findUserByEmail(
      await scopeFromRequestHost(req, "resend confirmation: host did not resolve to a tenant"),
      email,
      { select: { id: true, firstName: true, lastName: true, role: true, emailConfirmedAt: true } },
    );
    if (!user || !(await signInNeedsConfirmation(user))) {
      apiLogger.info({ msg: "auth/resend-confirmation:nothing-to-send", ip, userId: user?.id ?? null });
      return NextResponse.json(ACCEPTED);
    }

    // Not awaited (portal review, Nov 9, 2026): waiting for SES only on this
    // path made the response slower exactly when the address has a pending
    // sign-up. The outcome is still logged.
    void sendEmailVerification({ email, name: `${user.firstName} ${user.lastName}`.trim(), purpose: "account" })
      .then((sent) => apiLogger.info({ msg: "auth/resend-confirmation:sent", userId: user.id, confirmation: sent }))
      .catch((err) => apiLogger.error({ err, msg: "auth/resend-confirmation:send-failed", userId: user.id }));
    return NextResponse.json(ACCEPTED);
  } catch (err) {
    apiLogger.error({ err, msg: "auth/resend-confirmation:error" });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
