import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth.config";
import { maxBodySizeFor } from "@/lib/body-limits";
import { confinementRedirect } from "@/lib/route-confinement";

// Use the Edge-compatible auth config (no Node.js modules like bcrypt, prisma)
const { auth } = NextAuth(authConfig);

const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// Use console with structured JSON so logs stay parseable. (The pino logger
// lives in src/lib/logger.ts and is fine to import now that proxy defaults to
// Node.js runtime in Next.js 16, but keeping this lean helper avoids coupling
// the proxy to the rest of the app's logging stack.)
function logWarn(msg: string, data?: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: "warn", module: "middleware", msg, time: new Date().toISOString(), ...data }));
}

// ── Body size limits ──
// Reject oversized request bodies early to prevent abuse. 1MB default for JSON
// API routes; CSV imports (JSON-encoded) and file uploads (multipart) get
// larger allowances. The decision lives in src/lib/body-limits.ts so it can be
// unit tested without dragging NextAuth into the test.
//
// ⚠ A UNIT TEST OF A ROUTE HANDLER CANNOT SEE THIS. Middleware is not in the
// handler's call path, so a route test asserting "rejects a file over 5MB"
// passes against its own in-route check while every real request is capped
// here first. That is how the 1MB ceiling silently overrode every documented
// upload cap for months (Aug 14, 2026). The limit is testable only in
// body-limits.test.ts or end to end.

// ── Mobile app CORS ──
// Allowed origins for mobile app development and production.
// In production, the mobile app sends no Origin (native HTTP client), so CORS
// headers are mainly needed for Expo dev server during development.
const MOBILE_ALLOWED_ORIGINS = new Set(
  (process.env.MOBILE_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)
);

/** Add CORS headers for mobile client requests */
function addCorsHeaders(
  response: NextResponse,
  origin: string | null
): NextResponse {
  if (origin && MOBILE_ALLOWED_ORIGINS.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-org-id");
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Max-Age", "86400");
  }
  return response;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin");

  // ── Pass-through for MCP + MCP OAuth routes ──
  // These routes have their own CORS handling via src/lib/mcp-cors.ts — the
  // mobile-only MOBILE_ALLOWED_ORIGINS list doesn't include claude.ai, so
  // intercepting here would block every browser-based MCP client. Let each
  // route's OPTIONS handler do the right thing.
  if (pathname.startsWith("/api/mcp")) {
    return NextResponse.next();
  }

  // ── CORS preflight for mobile clients ──
  if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
    const response = new NextResponse(null, { status: 204 });
    return addCorsHeaders(response, origin);
  }

  // ── Request body size check for API routes ──
  if (pathname.startsWith("/api/") && MUTATION_METHODS.has(req.method)) {
    const contentLength = req.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      const maxSize = maxBodySizeFor(pathname, req.headers.get("content-type"));
      if (!Number.isNaN(size) && size > maxSize) {
        logWarn("Request body too large", { pathname, contentLength: size, maxSize });
        return addCorsHeaders(
          NextResponse.json(
            { error: "Request body too large" },
            { status: 413 }
          ),
          origin
        );
      }
    }
  }

  // ── CSRF protection for authenticated API mutations ──
  // Validates that the request Origin matches the Host header.
  // Skips: auth endpoints, public endpoints, health check, and API-key requests.
  if (
    pathname.startsWith("/api/") &&
    MUTATION_METHODS.has(req.method) &&
    !pathname.startsWith("/api/auth/") &&
    !pathname.startsWith("/api/public/") &&
    !pathname.startsWith("/api/webhooks/") &&
    !pathname.startsWith("/api/health") &&
    !pathname.startsWith("/api/mcp")
  ) {
    const host = req.headers.get("host");

    // Browser requests always send Origin — validate it regardless of API-key headers
    // to prevent CSRF via forged headers
    if (origin && host) {
      // Allow whitelisted mobile origins through without Origin/Host matching
      if (!MOBILE_ALLOWED_ORIGINS.has(origin)) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          logWarn("CSRF invalid origin URL", { pathname, origin });
          return addCorsHeaders(
            NextResponse.json({ error: "Forbidden" }, { status: 403 }),
            origin
          );
        }
        if (originHost !== host) {
          logWarn("CSRF origin mismatch", { pathname, origin, host });
          return addCorsHeaders(
            NextResponse.json({ error: "Forbidden" }, { status: 403 }),
            origin
          );
        }
      }
    }

    // No Origin header — only allow non-browser clients with API key or Bearer token
    // (native mobile apps send no Origin header and use Bearer tokens)
    if (!origin) {
      const hasApiKey =
        req.headers.get("x-api-key") ||
        req.headers.get("authorization")?.startsWith("Bearer ");

      if (!hasApiKey) {
        logWarn("CSRF missing origin", { pathname });
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  // ── Confinement: where this person may go in the dashboard UI ──
  // One pure function (src/lib/route-confinement.ts), pinned by a role-by-path
  // matrix. API routes always pass: each carries its own permission check.
  const target = confinementRedirect(req.auth?.user?.role, pathname);
  if (target) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = target;
    return NextResponse.redirect(redirectUrl);
  }
  return addCorsHeaders(NextResponse.next(), origin);
});

export const config = {
  matcher: [
    /*
     * Run middleware on:
     * 1. Dashboard routes — reviewer/submitter access restriction
     * 2. API routes — CSRF origin validation on mutations
     * Skips: public pages (/e/*), auth pages, and static assets.
     */
    "/events/:path*",
    "/dashboard/:path*",
    "/settings/:path*",
    "/contacts/:path*",
    "/profile/:path*",
    "/logs/:path*",
    // The org-level Event Agent page (Sep 21, 2026): the confined roles and
    // the org-null roles are redirected like every other org surface.
    "/agent/:path*",
    // Org-wide invoice ledger — needed so the WEBINARS (and CRM_USER)
    // confinement branches actually run on it (review H-1: it was outside
    // the matcher, so NO role branch ever executed there).
    "/invoices/:path*",
    // App-wide Analytics (Sep 25, 2026): in the matcher so the confined roles
    // are redirected from it like every other org page.
    "/analytics/:path*",
    // The module and org pages route-confinement.ts already maps to an area,
    // which were outside the matcher, so their rules never ran (Phase 6
    // review, Oct 7, 2026): a desk or HR account opened the CRM's page shell.
    // The API stays the authority; this is the UI redirect.
    "/crm/:path*",
    "/hr/:path*",
    "/procurement/:path*",
    "/activity/:path*",
    "/media/:path*",
    "/my-registration/:path*",
    "/api/:path*",
  ],
};
