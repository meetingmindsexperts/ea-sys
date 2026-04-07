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
      return NextResponse.json(
        { error: "Too many requests. Try again later." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
      );
    }

    const body = await req.json();
    const validated = refreshSchema.safeParse(body);
    if (!validated.success) {
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

    // Re-validate user still exists and fetch current role
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User no longer exists" },
        { status: 401 }
      );
    }

    const tokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId ?? null,
      organizationName: user.organization?.name ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
    };

    const accessToken = createMobileAccessToken(tokenPayload);
    const refreshToken = createMobileRefreshToken(tokenPayload);

    apiLogger.info({
      msg: "Mobile token refreshed",
      userId: user.id,
    });

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
