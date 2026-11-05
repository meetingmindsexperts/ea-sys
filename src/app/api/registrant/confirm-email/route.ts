import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { sendEmailVerification } from "@/lib/email-verification";
import { needsEmailVerification } from "@/lib/internal-domains";
import { resolveRequestOrgId } from "@/lib/tenant/resolver";
import { runWithTenantLane } from "@/lib/tenant-lane";

/**
 * The signed-in person's own address confirmation (Nov 5, 2026;
 * docs/ACCOUNT_CONFIRMATION_PLAN.md).
 *
 *   GET   whether their address is confirmed (the My events notice asks)
 *   POST  send them a confirmation link
 *
 * The link goes to the ACCOUNT's own address, read from the database, never
 * to an address in the request, so this cannot be pointed at someone else.
 * Confirming lets registrations made earlier under that address appear on
 * My events (src/lib/registrant-access.ts).
 */

const SEND_LIMIT = 3;
const SEND_WINDOW_MS = 60 * 60 * 1000;

async function account(userId: string) {
  return db.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true, lastName: true, emailConfirmedAt: true } });
}

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = session.user.id;
    // A registrant is org-null, so the lane comes from the host, as sign-in does.
    return await runWithTenantLane(await resolveRequestOrgId(req), { route: "registrant/confirm-email:GET", userId }, async () => {
      const user = await account(userId);
      if (!user) {
        apiLogger.warn({ msg: "registrant/confirm-email:GET user-not-found", userId });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ confirmed: !!user.emailConfirmedAt, email: user.email });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "registrant/confirm-email:GET failed" });
    return NextResponse.json({ error: "Could not check your email" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const userId = session.user.id;

    const rl = checkRateLimit({ key: `registrant-confirm-email:${userId}`, limit: SEND_LIMIT, windowMs: SEND_WINDOW_MS });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "registrant/confirm-email:rate-limited", userId, retryAfterSeconds: rl.retryAfterSeconds });
      return NextResponse.json(
        { error: `Please wait ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s) before asking for another link.`, retryAfterSeconds: rl.retryAfterSeconds, limit: SEND_LIMIT, windowSeconds: SEND_WINDOW_MS / 1000 },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    return await runWithTenantLane(await resolveRequestOrgId(req), { route: "registrant/confirm-email:POST", userId }, async () => {
      const user = await account(userId);
      if (!user) {
        apiLogger.warn({ msg: "registrant/confirm-email:POST user-not-found", userId });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (user.emailConfirmedAt) return NextResponse.json({ confirmed: true, sent: false });

      await sendEmailVerification({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`.trim() || user.email,
        // A Meeting Minds address keeps the team wording; confirming it also
        // attaches the organisation, as it always has.
        purpose: needsEmailVerification(user.email) ? "team" : "registrations",
      });
      apiLogger.info({ msg: "registrant/confirm-email:sent", userId });
      return NextResponse.json({ confirmed: false, sent: true });
    });
  } catch (err) {
    apiLogger.error({ err, msg: "registrant/confirm-email:POST failed" });
    return NextResponse.json({ error: "Could not send the link" }, { status: 500 });
  }
}
