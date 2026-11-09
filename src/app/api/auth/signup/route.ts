import { NextResponse } from "next/server";
import { Prisma, type UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { findUserByEmail, scopeFromRequestHost } from "@/lib/tenant/user-lookup";
import { sendEmailVerification } from "@/lib/email-verification";
import { sendEmail, emailTemplates } from "@/lib/email";
import { SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN, signInNeedsConfirmation } from "@/lib/account-signup";
import { personalDetailsFields } from "@/lib/schemas";
import { newAccountProfileData, normalizeDetails } from "@/lib/registrant-details";

/**
 * Create an account without registering for an event (Nov 5, 2026; phase 2 of
 * docs/ACCOUNT_CONFIRMATION_PLAN.md). The account is a REGISTRANT with no
 * organisation, like one made on a registration form, but it cannot sign in
 * until its address is confirmed (account-signup.ts), so a sign-up on someone
 * else's address gives the person who made it nothing.
 *
 * THE ANSWER NEVER SAYS WHETHER AN ADDRESS HAS AN ACCOUNT. Every accepted
 * request gets the same response: a new address is sent a confirmation link,
 * an address with an unconfirmed sign-up is sent its link again, and an
 * address with an account is sent a "you already have an account" note. The
 * password is hashed on every path so the timing does not tell them apart.
 *
 * It asks the public registration form's personal questions (Nov 9, 2026), kept
 * on the account (AccountProfile) so a later registration starts filled in,
 * and the marketing tick box. An address that already has an account changes
 * nothing about that account: its details stay as they are.
 */

const schema = z
  .object({
    // The public registration form's personal questions, its own rules
    // (owner, Nov 9, 2026: sign-up asks what registering asks).
    ...personalDetailsFields,
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255),
    password: z.string().min(SIGNUP_PASSWORD_MIN).max(SIGNUP_PASSWORD_MAX),
    acceptTerms: z.literal(true),
    // Only ever true when the person ticked an unticked box.
    marketingConsent: z.boolean().optional(),
    // A field people never see; a bot that fills every input fills it.
    website: z.string().max(200).optional(),
  })
  .strict()
  .refine((d) => d.specialty !== "Others" || (d.customSpecialty?.trim().length ?? 0) > 0, {
    message: "Please enter your specialty",
    path: ["customSpecialty"],
  });

const ACCEPTED = { ok: true, message: "If this address can be used for a new account, we have sent a link to it." };

function tooMany(retryAfterSeconds: number, limit: number, windowSeconds: number) {
  return NextResponse.json(
    { error: "Too many attempts. Please try again later.", retryAfterSeconds, limit, windowSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const burst = checkRateLimit({ key: `signup:ip-burst:${ip}`, limit: 5, windowMs: 60 * 1000 });
    if (!burst.allowed) {
      apiLogger.warn({ msg: "auth/signup:rate-limited", bucket: "ip-burst", ip });
      return tooMany(burst.retryAfterSeconds, 5, 60);
    }
    const sustained = checkRateLimit({ key: `signup:ip:${ip}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!sustained.allowed) {
      apiLogger.warn({ msg: "auth/signup:rate-limited", bucket: "ip", ip });
      return tooMany(sustained.retryAfterSeconds, 20, 3600);
    }

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      // Field names only: the body carries a password.
      const flat = parsed.error.flatten();
      apiLogger.warn({ msg: "auth/signup:validation-failed", fields: Object.keys(flat.fieldErrors), formErrors: flat.formErrors, ip });
      return NextResponse.json({ error: "Please check the form and try again." }, { status: 400 });
    }
    const { password, website } = parsed.data;
    const details = normalizeDetails(parsed.data);
    const { firstName, lastName } = details;
    const email = parsed.data.email.toLowerCase();

    if (website) {
      apiLogger.warn({ msg: "auth/signup:honeypot", ip });
      return NextResponse.json(ACCEPTED);
    }

    const perAddress = checkRateLimit({ key: `signup:email:${email}`, limit: 3, windowMs: 60 * 60 * 1000 });
    if (!perAddress.allowed) {
      apiLogger.warn({ msg: "auth/signup:rate-limited", bucket: "email", ip });
      return tooMany(perAddress.retryAfterSeconds, 3, 3600);
    }

    // Before the lookup, so a new address and an existing one take as long.
    const passwordHash = await bcrypt.hash(password, 10);
    // The tenant comes from the host, as at sign-in: on the platform one
    // address may be an account in two tenants.
    const scope = await scopeFromRequestHost(req, "sign-up: host did not resolve to a tenant");
    const existing = await findUserByEmail(scope, email, {
      select: { id: true, firstName: true, lastName: true, role: true, emailConfirmedAt: true },
    });
    if (existing) {
      await answerExistingAddress(req, email, existing);
      return NextResponse.json(ACCEPTED);
    }

    let userId: string;
    try {
      const user = await db.user.create({
        data: {
          email,
          passwordHash,
          firstName,
          lastName,
          role: "REGISTRANT",
          // No organisation, like every registrant account. A Meeting Minds
          // address joins the team when it confirms (verify-email).
          organizationId: null,
          termsAcceptedAt: new Date(),
          termsAcceptedIp: ip,
          specialty: details.specialty,
          // The account's own details, made in the same write so an account
          // never exists without them (registrant-details.ts).
          accountProfile: { create: newAccountProfileData(details, parsed.data.marketingConsent === true, ip) },
        },
        select: { id: true },
      });
      userId = user.id;
    } catch (err) {
      // Two sign-ups for one address at once: the second answers as the first did.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        apiLogger.warn({ msg: "auth/signup:create-raced", ip });
        return NextResponse.json(ACCEPTED);
      }
      throw err;
    }

    const sent = await sendEmailVerification({ email, name: `${firstName} ${lastName}`, purpose: "account" });
    apiLogger.info({ msg: "auth/signup:account-created", userId, confirmation: sent });
    return NextResponse.json(ACCEPTED);
  } catch (err) {
    apiLogger.error({ err, msg: "auth/signup:error" });
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

/**
 * An address that already has an account: a sign-up still waiting for its
 * confirmation gets the link again; any other account is told it exists, by
 * email, which only the address's owner reads. Nothing about the account changes.
 */
async function answerExistingAddress(
  req: Request,
  email: string,
  user: { id: string; firstName: string; lastName: string; role: UserRole; emailConfirmedAt: Date | null },
): Promise<void> {
  const name = `${user.firstName} ${user.lastName}`.trim();
  if (await signInNeedsConfirmation(user)) {
    const sent = await sendEmailVerification({ email, name, purpose: "account" });
    apiLogger.info({ msg: "auth/signup:unconfirmed-resent", userId: user.id, confirmation: sent });
    return;
  }
  // The same per-address ceiling as confirmation links, so repeated sign-ups
  // on someone's address cannot become a mail flood to them.
  const rl = checkRateLimit({ key: `email-confirmation-send:${email}`, limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) {
    apiLogger.warn({ msg: "auth/signup:account-exists-note-rate-limited", userId: user.id });
    return;
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const tpl = emailTemplates.accountExists({
    recipientName: name,
    signInLink: `${appUrl}/login`,
    resetLink: `${appUrl}/forgot-password`,
  });
  const result = await sendEmail({
    to: [{ email, name }],
    subject: tpl.subject,
    htmlContent: tpl.htmlContent,
    textContent: tpl.textContent,
    emailType: "account_exists",
    stream: "transactional",
    logContext: { entityType: "USER", entityId: user.id, templateSlug: "account-exists" },
  });
  if (!result.success) {
    apiLogger.warn({ msg: "auth/signup:account-exists-note-failed", userId: user.id, error: result.error });
    return;
  }
  apiLogger.info({ msg: "auth/signup:account-exists-note-sent", userId: user.id });
}
