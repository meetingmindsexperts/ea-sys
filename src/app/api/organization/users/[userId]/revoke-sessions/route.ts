import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";

/**
 * Sign someone out of every device, without locking them out.
 *
 * WHY THIS EXISTS. `tokenVersion` shipped on Aug 11 2026 as the revocation
 * lever for stateless JWT sessions, and until now exactly two things bumped
 * it: deactivating an account, and completing a password reset. So the only
 * button an admin had for "this person's laptop was stolen / a token leaked"
 * was DEACTIVATE, which also stops the legitimate owner signing back in and
 * needs a second admin action to undo. The blunt instrument was the only
 * instrument.
 *
 * This is the sharp one. It bumps the counter and touches nothing else: the
 * role, the password and `deactivatedAt` are all untouched, so the person
 * signs straight back in with the credentials they already have while every
 * token minted before this moment is dead.
 *
 * WHEN IT BITES. Team roles are re-validated on EVERY request, so for staff
 * this is immediate; everyone else is checked every 5 minutes. A mobile
 * refresh token dies at its next refresh. A mobile ACCESS token keeps working
 * for the remainder of its 24h by design — see the `ponytail:` note in
 * api-auth.ts, which records that trade and its two upgrade paths. Say so in
 * the UI rather than implying the revocation is total.
 *
 * SELF IS ALLOWED, deliberately unlike deactivation. "Sign me out everywhere,
 * I left a session open on a shared machine" is a legitimate and reversible
 * thing to want; locking yourself out is not. The caller's own session dies
 * with the rest, which is the intent.
 */

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ userId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      apiLogger.warn({ msg: "revoke-sessions:unauthenticated", ip: getClientIp(req) });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const org = requireOrgId(session, { route: "organization/users/[userId]/revoke-sessions:POST" });
    if ("error" in org) return org.error;

    const isSelf = session.user.id === userId;
    const isAdmin = session.user.role === "ADMIN" || session.user.role === "SUPER_ADMIN";
    if (!isAdmin && !isSelf) {
      apiLogger.warn({
        msg: "revoke-sessions:forbidden",
        callerRole: session.user.role,
        userId: session.user.id,
        targetUserId: userId,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Keyed on the CALLER, not the target: the thing worth bounding is one
    // account driving the endpoint, and a genuine incident touches a handful
    // of people, not thirty.
    const limit = checkRateLimit({
      key: `revoke-sessions:${session.user.id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!limit.allowed) {
      return rateLimited(limit, {
        route: "organization/users/revoke-sessions",
        userId: session.user.id,
      });
    }

    // Org-bound on the WRITE, not merely on a preceding read — the house
    // invariant, so a refactor that drops a lookup cannot turn this into a
    // cross-tenant session kill. `updateMany` because `update` throws P2025
    // on a miss, and a miss here means "not your org", which is a 404.
    const result = await db.user.updateMany({
      where: { id: userId, organizationId: org.orgId },
      data: { tokenVersion: { increment: 1 } },
    });

    if (result.count === 0) {
      apiLogger.warn({
        msg: "revoke-sessions:user-not-found",
        userId: session.user.id,
        targetUserId: userId,
      });
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Read back rather than computing the new value: the counter is a shared
    // integer and two admins reacting to the same incident is the normal case,
    // so the number in the audit row should be the one the database landed on.
    const updated = await db.user.findFirst({
      where: { id: userId, organizationId: org.orgId },
      select: { email: true, firstName: true, lastName: true, tokenVersion: true },
    });

    await db.auditLog
      .create({
        data: {
          userId: session.user.id,
          organizationId: org.orgId,
          action: "REVOKE_SESSIONS",
          entityType: "User",
          entityId: userId,
          changes: {
            targetEmail: updated?.email ?? null,
            tokenVersion: updated?.tokenVersion ?? null,
            self: isSelf,
            ip: getClientIp(req),
          },
        },
      })
      .catch((err) =>
        // Fire-and-forget with a logged catch: the revocation has already
        // committed, and failing the request would tell the admin it did not
        // happen when it did.
        apiLogger.error({ err, msg: "revoke-sessions:audit-write-failed", targetUserId: userId }),
      );

    apiLogger.info({
      msg: "revoke-sessions:revoked",
      userId: session.user.id,
      targetUserId: userId,
      self: isSelf,
      tokenVersion: updated?.tokenVersion ?? null,
    });

    return NextResponse.json({
      revoked: true,
      self: isSelf,
      tokenVersion: updated?.tokenVersion ?? null,
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "revoke-sessions:failed", ip: getClientIp(req) });
    return NextResponse.json({ error: "Failed to revoke sessions" }, { status: 500 });
  }
}
