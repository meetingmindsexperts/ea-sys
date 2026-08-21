import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { recordLoginEvent, readUserAgent } from "@/lib/login-audit";
import {
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
} from "@/lib/login-throttle";
import { touchLastSeen } from "@/lib/active-users";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { findUserByEmail, userEmailScope } from "@/lib/tenant/user-lookup";
import {
  createMobileAccessToken,
  createMobileRefreshToken,
} from "@/lib/mobile-jwt";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: Request) {
  try {
    // The IP used to come from `x-forwarded-for.split(",")[0]` — the FIRST
    // entry, which is client-supplied on a directly-exposed origin. Anyone
    // could forge a different value per request and get a fresh rate-limit
    // bucket every time, so the limit here was effectively decorative.
    // `getClientIp` reads nginx's `X-Real-IP` (the real socket peer) instead;
    // see the reasoning in src/lib/security.ts.
    const ip = getClientIp(req);
    const userAgent = readUserAgent(req);

    const body = await req.json();
    const validated = loginSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "auth/mobile-login:invalid-input", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid email or password format" },
        { status: 400 }
      );
    }

    const email = validated.data.email.toLowerCase();

    // Same lookup-first ordering as the web path: every recorded outcome,
    // including a throttled one, is attributed to the right user and org.
    // Tenant from the HOST, exactly as the web sign-in does: the credential
    // cannot name a tenant, and on the platform one address may exist in two.
    const tenant = await resolveTenantOrg(normalizeHost(req.headers.get("host")));
    const user = await findUserByEmail(
      userEmailScope(tenant.orgId, "mobile sign-in: host did not resolve to a tenant"),
      email,
      {
        select: {
          id: true,
          email: true,
          passwordHash: true,
          firstName: true,
          lastName: true,
          role: true,
          organizationId: true,
          organization: {
            select: { name: true },
          },
        },
      },
    );

    // ONE throttle policy shared with the web login (src/lib/login-throttle.ts)
    // rather than this route's own numbers: only failures are charged, a
    // success resets, and the per-email bucket does the real work so a venue
    // sharing one NAT address can't lock itself out.
    const throttle = isLoginBlocked(email, ip);
    if (throttle.blocked) {
      apiLogger.warn({
        msg: "auth/mobile-login:rate-limited",
        retryAfterSeconds: throttle.retryAfterSeconds,
        reason: throttle.reason,
        ip,
        userId: user?.id ?? null,
      });
      void recordLoginEvent({
        email,
        outcome: "BLOCKED_RATE_LIMIT",
        surface: "MOBILE",
        userId: user?.id ?? null,
        organizationId: user?.organizationId ?? null,
        ipAddress: ip,
        userAgent,
      });
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(throttle.retryAfterSeconds) },
        }
      );
    }

    if (!user || !user.passwordHash) {
      apiLogger.warn({ msg: "auth/mobile-login:unknown-email", email, ip });
      recordLoginFailure(email, ip);
      void recordLoginEvent({
        email,
        outcome: "FAILED_UNKNOWN_EMAIL",
        surface: "MOBILE",
        ipAddress: ip,
        userAgent,
      });
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const isValid = await bcrypt.compare(
      validated.data.password,
      user.passwordHash
    );
    if (!isValid) {
      apiLogger.warn({
        msg: "auth/mobile-login:bad-password",
        email,
        ip,
        userId: user.id,
      });
      recordLoginFailure(email, ip);
      void recordLoginEvent({
        email,
        outcome: "FAILED_PASSWORD",
        surface: "MOBILE",
        userId: user.id,
        organizationId: user.organizationId,
        ipAddress: ip,
        userAgent,
      });
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    clearLoginFailures(email);
    void recordLoginEvent({
      email,
      outcome: "SUCCESS",
      surface: "MOBILE",
      userId: user.id,
      organizationId: user.organizationId,
      ipAddress: ip,
      userAgent,
    });
    void touchLastSeen(user.id);

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
      msg: "Mobile login successful",
      userId: user.id,
      role: user.role,
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
    apiLogger.error({ err, msg: "Mobile login error" });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
