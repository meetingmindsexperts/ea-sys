import NextAuth, { CredentialsSignin } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { authLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { recordLoginEvent, readUserAgent } from "@/lib/login-audit";
import {
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
} from "@/lib/login-throttle";
import authConfig, { mapTokenToSessionUser } from "./auth.config";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  // Which login page this came from — a display label for the sign-in history,
  // NOT a security boundary (the client supplies it), hence no MOBILE value
  // here: the mobile app has its own route and stamps its own surface. Absent
  // means the dashboard.
  surface: z.enum(["DASHBOARD", "EVENT_PAGE"]).optional(),
});

/**
 * Thrown when the failed-attempt throttle is engaged.
 *
 * The `code` lands in the response so the login page can say "wait a few
 * minutes" instead of the misleading "invalid email or password" — a locked-out
 * admin who knows their password otherwise has no idea what is happening.
 *
 * This leaks nothing: the throttle counts failures per EMAIL regardless of
 * whether that address has an account, so being told you are throttled reveals
 * no information about whether the account exists.
 */
class RateLimitedSignin extends CredentialsSignin {
  code = "RateLimited";
}

/**
 * `getClientIp` expects a real `Request`. Auth.js does hand one to `authorize`,
 * but this runs on the critical path of signing in, so a shape surprise across
 * an Auth.js upgrade must degrade to "unknown IP" rather than break login.
 */
function safeClientIp(request: Request | undefined): string {
  try {
    return request ? getClientIp(request) : "unknown";
  } catch {
    return "unknown";
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  adapter: PrismaAdapter(db) as ReturnType<typeof PrismaAdapter>,
  session: {
    strategy: "jwt",
    // 24h ROLLING (idle) timeout — NOT a hard cap from login. NextAuth re-signs
    // the JWT with exp = now + maxAge and re-sets the cookie on every session
    // read (mount/focus/navigation), so the window slides forward on activity;
    // only a full 24h of inactivity logs the user out. No refresh token (single
    // signed JWT cookie). See docs/HANDOVER.md §4 "Session lifetime".
    maxAge: 24 * 60 * 60,
  },
  // Trust the host header from Vercel/proxies
  trustHost: true,
  pages: authConfig.pages,
  // Override providers with full implementation (Node.js runtime)
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        surface: { label: "Surface", type: "text" },
      },
      async authorize(credentials, request) {
        const validated = loginSchema.safeParse(credentials);
        if (!validated.success) {
          // A malformed payload can't authenticate against anything, so there
          // is no subject worth recording — but it must not be silent.
          authLogger.warn({
            msg: "auth:login-invalid-input",
            fieldErrors: validated.error.flatten().fieldErrors,
          });
          return null;
        }

        const email = validated.data.email.toLowerCase();
        const surface = validated.data.surface ?? "DASHBOARD";
        const ipAddress = safeClientIp(request);
        const userAgent = readUserAgent(request);

        // Look the account up FIRST so every outcome below — including a
        // throttled one — can be attributed to the right user and org. Without
        // this, a blocked attack on a real account would be recorded with a
        // null organizationId and therefore be invisible in the org-scoped
        // admin view, which is precisely the case an admin needs to see. This
        // is a single indexed lookup; the expensive step (bcrypt) still sits
        // behind the throttle.
        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            passwordHash: true,
            firstName: true,
            lastName: true,
            role: true,
            organizationId: true,
            organization: {
              select: { name: true, logo: true, primaryColor: true },
            },
          },
        });

        // ── Throttle: refuse before bcrypt so a flood costs us nothing ──
        const throttle = isLoginBlocked(email, ipAddress);
        if (throttle.blocked) {
          authLogger.warn({
            msg: "auth:login-throttled",
            email,
            ipAddress,
            reason: throttle.reason,
            retryAfterSeconds: throttle.retryAfterSeconds,
            userId: user?.id ?? null,
          });
          void recordLoginEvent({
            email,
            outcome: "BLOCKED_RATE_LIMIT",
            surface,
            userId: user?.id ?? null,
            organizationId: user?.organizationId ?? null,
            ipAddress,
            userAgent,
          });
          throw new RateLimitedSignin();
        }

        if (!user) {
          authLogger.warn({ msg: "auth:login-unknown-email", email, ipAddress });
          recordLoginFailure(email, ipAddress);
          void recordLoginEvent({
            email,
            outcome: "FAILED_UNKNOWN_EMAIL",
            surface,
            ipAddress,
            userAgent,
          });
          return null;
        }

        if (!user.passwordHash) {
          // Shouldn't happen — the column is non-nullable — but if it ever
          // does, this address IS known, so recording it as an unknown one
          // would tell an admin investigating a run of failures that nobody is
          // being targeted when somebody is.
          authLogger.error({
            msg: "auth:login-no-password-hash",
            email,
            ipAddress,
            userId: user.id,
          });
          recordLoginFailure(email, ipAddress);
          void recordLoginEvent({
            email,
            outcome: "FAILED_PASSWORD",
            surface,
            userId: user.id,
            organizationId: user.organizationId,
            ipAddress,
            userAgent,
          });
          return null;
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(
          validated.data.password,
          user.passwordHash
        );

        if (!isValidPassword) {
          authLogger.warn({
            msg: "auth:login-bad-password",
            email,
            ipAddress,
            userId: user.id,
          });
          recordLoginFailure(email, ipAddress);
          void recordLoginEvent({
            email,
            outcome: "FAILED_PASSWORD",
            surface,
            userId: user.id,
            organizationId: user.organizationId,
            ipAddress,
            userAgent,
          });
          return null;
        }

        // Two typos followed by a success should leave no trace, so the email
        // bucket is cleared. The IP bucket deliberately is not — see
        // login-throttle.ts.
        clearLoginFailures(email);
        void recordLoginEvent({
          email,
          outcome: "SUCCESS",
          surface,
          userId: user.id,
          organizationId: user.organizationId,
          ipAddress,
          userAgent,
        });

        // Return user object with required id
        return {
          id: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          organizationId: user.organizationId ?? null,
          organizationName: user.organization?.name ?? null,
          organizationLogo: user.organization?.logo ?? null,
          organizationPrimaryColor: user.organization?.primaryColor ?? null,
          firstName: user.firstName,
          lastName: user.lastName,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn() {
      return true;
    },
    async jwt({ token, user, trigger }) {
      // On sign in, populate token from user object
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.organizationId = user.organizationId ?? null;
        token.organizationName = user.organizationName ?? null;
        token.organizationLogo = user.organizationLogo ?? null;
        token.organizationPrimaryColor = user.organizationPrimaryColor ?? null;
        token.firstName = user.firstName;
        token.lastName = user.lastName;
        token.roleCheckedAt = Date.now();
      }

      // On explicit session update (e.g., after org settings change), refetch data
      if (trigger === "update" && token.id) {
        const dbUser = await db.user.findUnique({
          where: { id: token.id as string },
          include: { organization: { select: { name: true, logo: true, primaryColor: true } } },
        });
        if (dbUser) {
          token.organizationName = dbUser.organization?.name ?? null;
          token.organizationLogo = dbUser.organization?.logo ?? null;
          token.organizationPrimaryColor = dbUser.organization?.primaryColor ?? null;
          token.firstName = dbUser.firstName;
          token.lastName = dbUser.lastName;
          token.role = dbUser.role;
          token.roleCheckedAt = Date.now();
        }
      }

      // ── Periodic role re-validation (every 5 minutes) ──
      // Prevents stale JWT tokens retaining old roles after admin changes.
      // Lightweight query: selects only `role` by primary key.
      const ROLE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
      const lastChecked = (token.roleCheckedAt as number) || 0;
      if (token.id && Date.now() - lastChecked > ROLE_CHECK_INTERVAL) {
        try {
          const dbUser = await db.user.findUnique({
            where: { id: token.id as string },
            select: { role: true },
          });
          if (dbUser) {
            token.role = dbUser.role;
          }
          token.roleCheckedAt = Date.now();
        } catch (error) {
          authLogger.warn({ err: error, msg: "Role re-validation DB error, continuing with cached role", userId: token.id });
        }
      }

      return token;
    },
    async session({ session, token }) {
      return mapTokenToSessionUser(session, token);
    },
  },
});
