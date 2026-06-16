import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp, hashVerificationToken } from "@/lib/security";
import { needsEmailVerification } from "@/lib/internal-domains";
import { EMAIL_VERIFY_PREFIX } from "@/lib/email-verification";

const schema = z.object({
  token: z.string().min(1).max(200),
  email: z.string().email().max(255),
});

/**
 * Confirm a verify-email link. On success: set `User.emailVerified` and — for a
 * verified-internal domain (meetingmindsdubai.com) — attach the organization,
 * which is the only thing verification unlocks (they were a normal external
 * registrant until now). Idempotent for an already-verified account.
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
        .catch(() => {});
      apiLogger.warn({ msg: "verify-email:token-expired", email });
      return NextResponse.json(
        { error: "This verification link has expired. Please request a new one." },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, emailVerified: true, organizationId: true },
    });
    if (!user) {
      await db.verificationToken
        .delete({ where: { identifier_token: { identifier, token: tokenHash } } })
        .catch(() => {});
      apiLogger.warn({ msg: "verify-email:user-not-found", email });
      return NextResponse.json({ error: "Account not found." }, { status: 404 });
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
        data: { emailVerified: new Date(), ...(orgIdToAttach ? { organizationId: orgIdToAttach } : {}) },
      });
      await tx.verificationToken.delete({
        where: { identifier_token: { identifier, token: tokenHash } },
      });
    });

    apiLogger.info({
      msg: "verify-email:verified",
      email,
      userId: user.id,
      orgAttached: !!orgIdToAttach && !user.organizationId,
      wasInternal: needsEmailVerification(email),
    });

    return NextResponse.json({ success: true, message: "Your email has been verified." });
  } catch (error) {
    apiLogger.error({ err: error, msg: "verify-email:error" });
    return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 500 });
  }
}
