/**
 * GET /api/organization/active-users
 *
 * Who in this organization is currently using the product, and when everyone
 * else was last active.
 *
 * This answers a different question from the sign-in history next to it:
 * `LoginEvent` records ATTEMPTS (including failures, from any address), whereas
 * this reads `User.lastSeenAt` — a live presence signal for accounts that
 * already hold a session. A person who signed in yesterday and never closed
 * their laptop shows as online here and has no row in today's sign-in history.
 *
 * Same ADMIN+ boundary as the sign-in history it sits beside — see
 * src/lib/login-visibility.ts for why that is its own predicate.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { denyLoginActivity } from "@/lib/login-visibility";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import {
  isOnlineNow,
  onlineSince,
  LAST_SEEN_ONLINE_WINDOW_MS,
} from "@/lib/active-users";

const ROUTE = "GET /api/organization/active-users";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      apiLogger.warn({ msg: `${ROUTE}:unauthenticated` });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const org = requireOrgId(session, { route: ROUTE });
    if ("error" in org) return org.error;

    const denied = denyLoginActivity({
      role: session.user.role,
      userId: session.user.id,
      organizationId: org.orgId,
    });
    if (denied) return denied;

    // The card polls, so give it a ceiling — generous enough that a normal
    // 30s poll across a working day never trips it.
    const rl = checkRateLimit({
      key: `active-users:${session.user.id}`,
      limit: 600,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, userId: session.user.id, limit: 600, windowSeconds: 3600 });
    }

    const now = new Date();

    // Org-scoped. Everyone in the org is listed — someone who has never been
    // seen (`lastSeenAt` null) is meaningful information, not a row to hide:
    // it's an account that has not been used since this shipped.
    const users = await db.user.findMany({
      where: { organizationId: org.orgId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        lastSeenAt: true,
      },
      orderBy: [
        // Most recently active first; never-seen accounts sink to the bottom.
        { lastSeenAt: { sort: "desc", nulls: "last" } },
        { firstName: "asc" },
      ],
    });

    const rows = users.map((u) => ({
      ...u,
      isOnline: isOnlineNow(u.lastSeenAt, now),
      isYou: u.id === session.user.id,
    }));

    return NextResponse.json({
      users: rows,
      onlineCount: rows.filter((r) => r.isOnline).length,
      onlineSince: onlineSince(now).toISOString(),
      onlineWindowMinutes: Math.round(LAST_SEEN_ONLINE_WINDOW_MS / 60000),
      now: now.toISOString(),
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to load active users" }, { status: 500 });
  }
}
