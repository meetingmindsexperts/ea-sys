import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";

// This config is Edge-compatible (no Node.js modules)
// The actual credential verification happens in auth.ts

/**
 * Project custom JWT claims onto session.user. Used by both the Node-runtime
 * session callback in auth.ts (for /api/auth/session) AND the Edge/Node
 * proxy's session callback (for middleware RBAC). Keep this file the single
 * source of truth so the two call sites can't drift.
 */
export function mapTokenToSessionUser(session: Session, token: JWT | null | undefined): Session {
  if (token && session.user) {
    session.user.id = (token.id as string) ?? session.user.id;
    session.user.role = token.role as string;
    session.user.organizationId = (token.organizationId as string) ?? null;
    session.user.organizationName = (token.organizationName as string) ?? null;
    session.user.organizationLogo = (token.organizationLogo as string) ?? null;
    session.user.organizationPrimaryColor = (token.organizationPrimaryColor as string) ?? null;
    session.user.firstName = (token.firstName as string) ?? "";
    session.user.lastName = (token.lastName as string) ?? "";
  }
  return session;
}

/**
 * Session lifetime — declared ONCE and consumed by BOTH NextAuth instances.
 *
 * There are two: the Node one in `auth.ts` (the app + /api/auth/session) and
 * the Edge one in `proxy.ts` (`NextAuth(authConfig)`, for middleware RBAC).
 * They read and re-issue the SAME cookie, so whichever writes last decides how
 * long the session lives.
 *
 * Until Aug 17 2026 only `auth.ts` set `maxAge`. This config was silent — and a
 * silent config does not inherit the other one, it opts into NextAuth's DEFAULT
 * of 30 days. Middleware runs on every dashboard route, so it re-stamped the
 * cookie at 30 days and the documented idle timeout was never in force: a
 * session last signed in on Aug 7 was still live on Aug 17, across two weekends
 * and a shut-down laptop.
 *
 * Hence one exported constant rather than the same number written twice. This
 * is the same reasoning as `mapTokenToSessionUser` below — that kept the two
 * instances' session CLAIMS from drifting; nobody had carried it to the session
 * LIFETIME. Keep it that way: if you change this, both instances change.
 */
export const SESSION_CONFIG = {
  strategy: "jwt",
  /**
   * 48h ROLLING (idle) timeout, NOT a hard cap from login. Every session read
   * re-signs the JWT with `exp = now + maxAge` and re-sets the cookie, so the
   * window slides forward on use; only a full 48h of INACTIVITY signs someone
   * out. There is no refresh token — one signed JWT cookie.
   *
   * 48h and not 24h because staff live in this daily and a one-day window
   * re-prompts constantly; 48h and not a week because this account can move
   * money and we still cannot force a sign-out except by bumping
   * `User.tokenVersion`. Note it deliberately does NOT carry a weekend — a
   * Friday-evening finish is ~63h from Monday morning, so Monday is a fresh
   * login. Raise to 72h if that is ever unwanted.
   * See docs/HANDOVER.md §4 "Session lifetime".
   */
  maxAge: 48 * 60 * 60,
} as const;

export default {
  // Trust the host header from Vercel/proxies
  trustHost: true,
  session: SESSION_CONFIG,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      // Authorization is handled in auth.ts signIn callback
      // This just passes through the credentials
      authorize: async () => {
        // Return a minimal object - actual validation in signIn callback
        return null;
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  callbacks: {
    // Re-projects JWT claims onto session.user so proxy.ts and other Edge
    // callers see the same shape the app expects — without it,
    // req.auth.user.role is undefined and RBAC redirects silently fall
    // through. See mapTokenToSessionUser above for the full field list.
    session({ session, token }) {
      return mapTokenToSessionUser(session, token);
    },
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const pathname = nextUrl.pathname;

      // Public routes
      const publicRoutes = ["/login", "/register", "/forgot-password", "/reset-password"];
      const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route));

      // Protected routes
      const protectedRoutes = ["/dashboard", "/events", "/settings", "/my-registration"];
      const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

      // Redirect to login if not authenticated
      if (isProtectedRoute && !isLoggedIn) {
        return false;
      }

      const defaultHome = auth?.user?.role === "REGISTRANT" ? "/my-registration" : "/dashboard";

      // Redirect to home if authenticated and on public route
      if (isLoggedIn && isPublicRoute) {
        return Response.redirect(new URL(defaultHome, nextUrl));
      }

      // Redirect root to home if authenticated
      if (isLoggedIn && pathname === "/") {
        return Response.redirect(new URL(defaultHome, nextUrl));
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
