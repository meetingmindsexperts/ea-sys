import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";

// This config is Edge-compatible (no Node.js modules)
// The actual credential verification happens in auth.ts

export default {
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
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const pathname = nextUrl.pathname;

      // Public routes
      const publicRoutes = ["/login", "/register", "/forgot-password", "/reset-password"];
      const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route));

      // Protected routes
      const protectedRoutes = ["/dashboard", "/events", "/settings"];
      const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));

      // Redirect to login if not authenticated
      if (isProtectedRoute && !isLoggedIn) {
        return false;
      }

      // Redirect to dashboard if authenticated and on public route
      if (isLoggedIn && isPublicRoute) {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }

      // Redirect root to dashboard if authenticated
      if (isLoggedIn && pathname === "/") {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
