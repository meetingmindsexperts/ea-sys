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
import { touchLastSeen, LAST_SEEN_STAMP_INTERVAL_MS } from "@/lib/active-users";
import { decideSessionValidity } from "@/lib/session-validity";
import { isTeamRole } from "@/lib/team-roles";
import authConfig, { mapTokenToSessionUser, SESSION_CONFIG } from "./auth.config";

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
  // Shared with the Edge instance in proxy.ts — see SESSION_CONFIG in
  // auth.config.ts for the lifetime and for why it is declared there rather
  // than inline here. Do NOT re-inline a lifetime here — both instances write
  // the same cookie, and the one that stayed silent silently won at 30 days.
  session: SESSION_CONFIG,
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
            // Session revocation counter — stamped into the token below and
            // compared on every periodic re-validation. See the jwt callback.
            tokenVersion: true,
            deactivatedAt: true,
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

        // Deactivated accounts cannot sign in, even with the right password.
        // Checked AFTER the password so the response cannot be used to probe
        // which addresses are deactivated: a wrong password on a deactivated
        // account still reads as a wrong password.
        //
        // The failure counter is deliberately NOT cleared and NOT incremented.
        // Not incremented because they proved they know the password, so this
        // is not an attack; not cleared because clearing is a reward for a
        // successful sign-in, and this is not one.
        if (user.deactivatedAt) {
          authLogger.warn({
            msg: "auth:login-deactivated",
            email,
            ipAddress,
            userId: user.id,
            deactivatedAt: user.deactivatedAt.toISOString(),
          });
          void recordLoginEvent({
            email,
            outcome: "BLOCKED_DEACTIVATED",
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
        // Mark them online straight away. The JWT callback's periodic block
        // won't fire for another 5 minutes (signing in resets its clock), so
        // without this a person who just logged in would read as offline for
        // the first five minutes of their session.
        void touchLastSeen(user.id);

        // Return user object with required id
        return {
          id: user.id,
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
          tokenVersion: user.tokenVersion,
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
        token.tokenVersion = user.tokenVersion ?? 0;
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
      const ROLE_CHECK_INTERVAL = LAST_SEEN_STAMP_INTERVAL_MS; // 5 minutes
      const lastChecked = (token.roleCheckedAt as number) || 0;
      const dueForPeriodicCheck = Date.now() - lastChecked > ROLE_CHECK_INTERVAL;

      // Internal staff are re-validated on EVERY request so that deactivating
      // someone takes effect immediately rather than within 5 minutes (Aug 11,
      // 2026). `isTeamRole` reads the token, so deciding this costs nothing.
      //
      // The split is deliberate. Staff are tens of people, so a primary-key
      // lookup of three small columns per request is noise. Registrants and
      // attendees are thousands — the webinar presence heartbeat alone is
      // ~140 req/s at 5,000 attendees — and they are not a population you
      // "deactivate" anyway, so they keep the 5-minute cycle. One auth policy
      // for both populations is what would have made this expensive.
      //
      // If the pool ever objects, the lever is a short in-process cache on this
      // lookup (the `lobby-status` 3s micro-cache pattern), NOT reverting to
      // the periodic check.
      const isStaff = isTeamRole(token.role as string | undefined);

      if (token.id && (isStaff || dueForPeriodicCheck)) {
        // Presence stays on the 5-minute clock even for staff: it is what
        // drives "who is online now", and one write per user per 5 min is the
        // whole reason `lastSeenAt` was cheap enough to put on the User row.
        // Fire-and-forget — presence must never delay authentication, and
        // `touchLastSeen` never throws.
        if (dueForPeriodicCheck) {
          void touchLastSeen(token.id as string);
        }

        try {
          const dbUser = await db.user.findUnique({
            where: { id: token.id as string },
            select: { role: true, tokenVersion: true, deactivatedAt: true },
          });

          // The truth table lives in `decideSessionValidity` (pure, unit
          // tested). Returning null from this callback signs the holder out.
          //
          // Deliberately distinct from the `catch` below: a confirmed answer
          // ("no such user") is not the same as the ABSENCE of one (a thrown
          // pooler error). Treating a blip as a deletion would sign the whole
          // company out, so the catch keeps the cached role on purpose.
          const decision = decideSessionValidity(
            dbUser,
            token.tokenVersion as number | undefined,
          );
          if (decision.action === "invalidate") {
            authLogger.warn({
              msg: "auth:session-invalidated",
              reason: decision.reason,
              userId: token.id,
              tokenVersion: (token.tokenVersion as number | undefined) ?? 0,
              currentVersion: dbUser?.tokenVersion ?? null,
            });
            return null;
          }

          token.role = decision.role;
          // Only the periodic pass moves the clock. If a staff per-request
          // check refreshed it, `dueForPeriodicCheck` would never come true
          // for staff and they would stop being stamped as online.
          if (dueForPeriodicCheck) {
            token.roleCheckedAt = Date.now();
          }
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
