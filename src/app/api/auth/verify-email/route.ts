import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { findUserByEmail, scopeFromRequestHost } from "@/lib/tenant/user-lookup";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { needsEmailVerification } from "@/lib/internal-domains";
import { EMAIL_VERIFY_PREFIX } from "@/lib/email-verification";
import { linkConfirmedRegistrations, linkConfirmedSpeakers } from "@/lib/registrant-access";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";

const schema = z.object({
  token: z.string().min(1).max(200),
  email: z.string().email().max(255),
});

/**
 * Confirm a verify-email link. On success: set `User.emailVerified` and
 * `User.emailConfirmedAt` (the address is proven: the link was sent to it), link
 * the registrations made earlier under that address (registrant-access.ts), and,
 * for a verified-internal domain (meetingmindsdubai.com), attach the
 * organisation. Idempotent for an already-confirmed account.
 *
 * SIGNED IN AS THAT ACCOUNT, OR NOTHING (security review of 7cf4eb3b). The
 * link proves who owns the MAILBOX, not who owns the ACCOUNT: someone could
 * register with your address and their own password, the system would mail
 * you this link, and your click (or your mail scanner's) would confirm THEIR
 * account and hand it your registrations. So the click counts only from a
 * session of the account it names. The real owner of an account they did not
 * make takes it over with Forgot password instead, which signs the other
 * person out. The token is not spent on a refusal, so signing in and opening
 * the link again works.
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
    const session = await auth();
    if (!session?.user?.id) {
      apiLogger.warn({ msg: "verify-email:sign-in-required", email });
      return NextResponse.json(
        { error: "Sign in to the account for this email, then open the link again.", code: "SIGN_IN_REQUIRED" },
        { status: 401 }
      );
    }

    const user = await findUserByEmail(
      await scopeFromRequestHost(req, "email verification: host did not resolve to a tenant"),
      email,
      { select: { id: true, emailVerified: true, organizationId: true, tokenVersion: true } },
    );
    if (!user) {
      await db.verificationToken
        .delete({ where: { identifier_token: { identifier, token: tokenHash } } })
        .catch((err) => apiLogger.warn({ err, msg: "verify-email:orphaned-token-cleanup-failed", email }));
      apiLogger.warn({ msg: "verify-email:user-not-found", email });
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    // A session a password reset or invitation revoked still works for up to
    // five minutes before its re-check; it must not be the one that confirms
    // (security review of dd21f2c9).
    if (user.id === session.user.id && (session.user.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      apiLogger.warn({ msg: "verify-email:stale-session", email, userId: user.id });
      return NextResponse.json(
        { error: "Your session has ended. Sign in again, then open the link.", code: "SIGN_IN_REQUIRED" },
        { status: 401 }
      );
    }
    if (user.id !== session.user.id) {
      apiLogger.warn({ msg: "verify-email:wrong-account", email, sessionUserId: session.user.id });
      return NextResponse.json(
        { error: "You are signed in to a different account. Sign in to the account for this email, then open the link again.", code: "WRONG_ACCOUNT" },
        { status: 403 }
      );
    }

    // Resolve the org to attach — only for a verified-internal email that isn't
    // already org-bound. Prefer the most-recent registration's event org; fall
    // back to the single organization (single-org mode).
    let orgIdToAttach = user.organizationId ?? null;
    if (needsEmailVerification(email) && !orgIdToAttach) {
      const reg = await db.registration.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { event: { select: { organizationId: true } } },
      });
      orgIdToAttach =
        reg?.event.organizationId ??
        (await db.organization.findFirst({ select: { id: true } }))?.id ??
        null;
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
