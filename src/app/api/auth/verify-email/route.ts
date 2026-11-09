import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { findUserByEmail, scopeFromRequestHost } from "@/lib/tenant/user-lookup";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { verifyPublicCredentials } from "@/lib/public-credential-door";
import { readUserAgent } from "@/lib/login-audit";
import { needsEmailVerification } from "@/lib/internal-domains";
import { EMAIL_VERIFY_PREFIX } from "@/lib/email-verification";
import { linkConfirmedRegistrations, linkConfirmedSpeakers } from "@/lib/registrant-access";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";

const schema = z.object({
  token: z.string().min(1).max(200),
  email: z.string().email().max(255),
  /** The account's password, when the person is not signed in to it. */
  password: z.string().min(1).max(128).optional(),
});

/**
 * Confirm a verify-email link. On success: set `User.emailVerified` and
 * `User.emailConfirmedAt` (the address is proven: the link was sent to it), link
 * the registrations made earlier under that address (registrant-access.ts), and,
 * for a verified-internal domain (meetingmindsdubai.com), attach the
 * organisation. Idempotent for an already-confirmed account.
 *
 * THE ACCOUNT'S HOLDER, OR NOTHING (security review of 7cf4eb3b). The link
 * proves who owns the MAILBOX, not who owns the ACCOUNT: someone could
 * register with your address and their own password, the system would mail
 * you this link, and your click (or your mail scanner's) would confirm THEIR
 * account and hand it your registrations. So the click counts only with proof
 * of the account too: a current session of it, or its password typed on the
 * confirm page (Nov 5, 2026, for accounts made at /signup, which cannot sign
 * in before confirming). The real owner of an account they did not make takes
 * it over with Forgot password instead, which signs the other person out. The
 * token is not spent on a refusal, so trying again works.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = checkRateLimit({ key: `verify-email:ip:${ip}`, limit: 20, windowMs: 60 * 60 * 1000 });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "verify-email:rate-limited", ip });
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      apiLogger.warn({ msg: "verify-email:validation-failed", errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }

    const email = parsed.data.email.toLowerCase();
    const identifier = `${EMAIL_VERIFY_PREFIX}${email}`;
    const tokenHash = hashVerificationToken(parsed.data.token);

    const vt = await db.verificationToken.findFirst({ where: { identifier, token: tokenHash } });
    if (!vt) {
      apiLogger.warn({ msg: "verify-email:token-invalid", email });
      return NextResponse.json(
        { error: "This verification link is invalid or has already been used." },
        { status: 400 }
      );
    }
    if (vt.expires < new Date()) {
      await db.verificationToken
        .delete({ where: { identifier_token: { identifier, token: tokenHash } } })
        .catch((err) => apiLogger.warn({ err, msg: "verify-email:expired-token-cleanup-failed", email }));
      apiLogger.warn({ msg: "verify-email:token-expired", email });
      return NextResponse.json(
        { error: "This verification link has expired. Please request a new one." },
        { status: 400 }
      );
    }

    // The token proves the mailbox; the HOST proves the tenant. On the
    // platform one address may be two accounts, and VerificationToken is
    // keyed on the address alone, so the link's own domain is the only
    // thing that says which account this is for.
    const user = await findUserByEmail(
      await scopeFromRequestHost(req, "email verification: host did not resolve to a tenant"),
      email,
      { select: { id: true, emailVerified: true, organizationId: true, tokenVersion: true, passwordHash: true } },
    );
    if (!user) {
      await db.verificationToken
        .delete({ where: { identifier_token: { identifier, token: tokenHash } } })
        .catch((err) => apiLogger.warn({ err, msg: "verify-email:orphaned-token-cleanup-failed", email }));
      apiLogger.warn({ msg: "verify-email:user-not-found", email });
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }

    const refusal = await accountProof(req, email, user, parsed.data.password);
    if (refusal) return refusal;

    // Resolve the org to attach — only for a verified-internal email that isn't
    // already org-bound. Prefer the most-recent registration's event org, then
    // the host's organisation, then the ONLY organisation on a single-org
    // deployment. Never an arbitrary first one (portal review, Nov 9, 2026): a
    // /signup account has no registration, and on the platform "the first
    // organisation" is some other tenant.
    let orgIdToAttach = user.organizationId ?? null;
    if (needsEmailVerification(email) && !orgIdToAttach) {
      const reg = await db.registration.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { event: { select: { organizationId: true } } },
      });
      orgIdToAttach = reg?.event.organizationId ?? (await resolveRequestOrgId(req)) ?? (await soleOrganizationId());
    }

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          emailVerified: new Date(),
          emailConfirmedAt: new Date(),
          ...(orgIdToAttach ? { organizationId: orgIdToAttach } : {}),
        },
      });
      await tx.verificationToken.delete({
        where: { identifier_token: { identifier, token: tokenHash } },
      });
    });

    // The registrations made earlier under this address, inside the host's
    // tenant lane as every registrant read is. Best-effort: My events also
    // shows them by address now, so a failure here hides nothing.
    // The speaker records the organisers made on this address are claimed
    // too (upsertEventSpeaker waits for this step).
    const proven = { userId: user.id, email, confirmed: true };
    const hostOrgId = await resolveRequestOrgId(req);
    const [linked, speakers] = await runWithTenantLane(hostOrgId, { route: "auth/verify-email", userId: user.id }, () =>
      Promise.all([linkConfirmedRegistrations(proven), linkConfirmedSpeakers(proven, hostOrgId)]),
    ).catch((err) => {
      apiLogger.error({ err, msg: "verify-email:link-registrations-failed", userId: user.id });
      return [0, 0];
    });
    // A claimed speaker record still needs the sign-up's follow-through (its
    // details, presenter rate, badge registration): the page sends the person
    // back to the event's submission page, which now runs the full path for
    // this confirmed account (security review of dd21f2c9).
    const claimedEvents = speakers > 0
      ? await runWithTenantLane(hostOrgId, { route: "auth/verify-email", userId: user.id }, () =>
          db.speaker.findMany({
            where: {
              userId: user.id,
              email: { equals: email, mode: "insensitive" },
              // Only events this site shows and still takes submissions on.
              event: { status: { in: ["PUBLISHED", "LIVE"] }, ...(hostOrgId && { organizationId: hostOrgId }) },
            },
            select: { submitterSource: true, event: { select: { slug: true, name: true } } },
            take: 5,
          }),
        ).catch((err) => {
          apiLogger.warn({ err, msg: "verify-email:claimed-events-read-failed", userId: user.id });
          return [];
        })
      : [];

    apiLogger.info({
      msg: "verify-email:verified",
      email,
      userId: user.id,
      linkedRegistrations: linked,
      claimedSpeakers: speakers,
      orgAttached: !!orgIdToAttach && !user.organizationId,
      wasInternal: needsEmailVerification(email),
    });

    return NextResponse.json({
      success: true,
      message: "Your email has been verified.",
      claimedEvents: claimedEvents
        .filter((s) => s.event.slug)
        .map((s) => ({ slug: s.event.slug, name: s.event.name, door: s.submitterSource === "proposal" ? "proposal" : "abstract" })),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "verify-email:error" });
    return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 500 });
  }
}

/**
 * Whether the request proves it is the account's holder; a response refusing
 * it, or null. A password, when given, is checked through the shared
 * credential door (throttled, failures in Sign-in Activity); its success is
 * not recorded there because the page signs in straight afterwards and
 * `authorize()` records that. Otherwise the session must be this account's and
 * current: one a password reset or invitation revoked still works for up to
 * five minutes before its re-check (security review of dd21f2c9).
 */
async function accountProof(
  req: Request,
  email: string,
  user: { id: string; organizationId: string | null; tokenVersion: number | null; passwordHash: string | null },
  password: string | undefined,
): Promise<NextResponse | null> {
  if (password) {
    const check = await verifyPublicCredentials({
      email,
      password,
      user,
      ipAddress: getClientIp(req),
      userAgent: readUserAgent(req),
      surface: "DASHBOARD",
      recordSuccess: false,
      logLabel: "verify-email",
    });
    if (check.ok) return null;
    if (check.reason === "throttled") {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a few minutes and try again.", retryAfterSeconds: check.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(check.retryAfterSeconds) } },
      );
    }
    apiLogger.warn({ msg: "verify-email:bad-password", email, userId: user.id });
    return NextResponse.json({ error: "That password is not right for this account.", code: "BAD_PASSWORD" }, { status: 401 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    apiLogger.warn({ msg: "verify-email:sign-in-required", email });
    return NextResponse.json(
      { error: "Enter your password to confirm this account.", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }
  if (user.id === session.user.id && (session.user.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
    apiLogger.warn({ msg: "verify-email:stale-session", email, userId: user.id });
    return NextResponse.json(
      { error: "Your session has ended. Enter your password to confirm this account.", code: "SIGN_IN_REQUIRED" },
      { status: 401 },
    );
  }
  if (user.id !== session.user.id) {
    apiLogger.warn({ msg: "verify-email:wrong-account", email, sessionUserId: session.user.id });
    return NextResponse.json(
      { error: "You are signed in to a different account. Enter the password of the account for this email to confirm it.", code: "WRONG_ACCOUNT" },
      { status: 403 },
    );
  }
  return null;
}

/** The organisation's id when the deployment has exactly one, else null. */
async function soleOrganizationId(): Promise<string | null> {
  const orgs = await db.organization.findMany({ select: { id: true }, take: 2 });
  return orgs.length === 1 ? orgs[0].id : null;
}
