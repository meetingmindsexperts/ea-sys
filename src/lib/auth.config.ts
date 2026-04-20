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

export default {
  // Trust the host header from Vercel/proxies
  trustHost: true,
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
