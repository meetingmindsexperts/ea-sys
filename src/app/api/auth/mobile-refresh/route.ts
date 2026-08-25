import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import {
  verifyMobileToken,
  createMobileAccessToken,
  createMobileRefreshToken,
} from "@/lib/mobile-jwt";
import { touchLastSeen } from "@/lib/active-users";
import { decideSessionValidity } from "@/lib/session-validity";

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    // Rate limit: 30 refreshes per hour per IP
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = checkRateLimit({
      key: `mobile-refresh:${ip}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "auth/mobile-refresh:rate-limited", retryAfterSeconds: rl.retryAfterSeconds, ip });
      return NextResponse.json(
        { error: "Too many requests. Try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = refreshSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "auth/mobile-refresh:invalid-input", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Missing refresh token" },
        { status: 400 }
      );
    }

    const decoded = verifyMobileToken(validated.data.refreshToken);
    if (!decoded || decoded.type !== "refresh") {
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 }
      );
    }

    // Re-validate the account and fetch its current role.
    //
    // This used to check only that the user still EXISTED, which meant a
    // stolen refresh token kept minting fresh 24h access tokens for its full
    // 30-day life, and deactivating the account did nothing to stop it. Only
    // deleting the account closed it. It now asks the same question the web
    // JWT callback asks, through the same function, so the two cannot drift:
    // deleted, deactivated, or explicitly revoked all end the session here.
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        deactivatedAt: true,
        tokenVersion: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });

    const decision = decideSessionValidity(user, decoded.tokenVersion);
    if (decision.action === "invalidate" || !user) {
      apiLogger.warn({
        msg: "auth/mobile-refresh:session-invalidated",
        reason: decision.action === "invalidate" ? decision.reason : "user-deleted",
        userId: decoded.userId,
      });
      return NextResponse.json(
        { error: "Session is no longer valid. Please sign in again." },
        { status: 401 }
      );
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId ?? null,
      organizationName: user.organization?.name ?? null,
      tokenVersion: user.tokenVersion,
      firstName: user.firstName,
      lastName: user.lastName,
    };

    const accessToken = createMobileAccessToken(tokenPayload);
    const refreshToken = createMobileRefreshToken(tokenPayload);

    apiLogger.info({
      msg: "Mobile token refreshed",
      userId: user.id,
    });

    // The mobile equivalent of the web JWT callback's periodic block — this is
    // what keeps a mobile session showing as online between sign-ins.
    void touchLastSeen(user.id);

    return NextResponse.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        organizationId: user.organizationId,
        organizationName: user.organization?.name ?? null,
      },
    });
  } catch (err) {
    apiLogger.error({ err, msg: "Mobile token refresh error" });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
