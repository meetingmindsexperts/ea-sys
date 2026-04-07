import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth.config";

// Use the Edge-compatible auth config (no Node.js modules like bcrypt, prisma)
const { auth } = NextAuth(authConfig);

const MUTATION_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// Edge runtime — can't import Pino logger. Use console with structured JSON.
function logWarn(msg: string, data?: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: "warn", module: "middleware", msg, time: new Date().toISOString(), ...data }));
}

// ── Body size limits ──
// Reject oversized request bodies early to prevent abuse.
// 1MB default for JSON API routes; photo upload has its own 500KB app-level limit.
const MAX_BODY_SIZE = 1_048_576; // 1MB

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
      if (!Number.isNaN(size) && size > MAX_BODY_SIZE) {
        logWarn("Request body too large", { pathname, contentLength: size, maxSize: MAX_BODY_SIZE });
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

  // ── RBAC: Restricted role redirects ──
  const role = req.auth?.user?.role;

  // REGISTRANT: redirect everything to /my-registration
  if (role === "REGISTRANT") {
    if (pathname.startsWith("/my-registration") || pathname.startsWith("/api/")) {
      return addCorsHeaders(NextResponse.next(), origin);
    }
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/my-registration";
    return NextResponse.redirect(redirectUrl);
  }

  const isRestricted = role === "REVIEWER" || role === "SUBMITTER";

  if (!isRestricted) {
    return addCorsHeaders(NextResponse.next(), origin);
  }

  // Block restricted roles from dashboard, settings, and logs
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/settings") || pathname.startsWith("/logs")) {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/events";
    return NextResponse.redirect(redirectUrl);
  }

  // Block restricted roles from creating new events
  if (pathname === "/events/new") {
    const redirectUrl = req.nextUrl.clone();
    redirectUrl.pathname = "/events";
    return NextResponse.redirect(redirectUrl);
  }

  const eventPath = pathname.match(/^\/events\/[^/]+(?:\/(.*))?$/);

  if (!eventPath) {
    return addCorsHeaders(NextResponse.next(), origin);
  }

  const eventSubPath = eventPath[1] ?? "";
  const isAbstractsPath = eventSubPath === "abstracts" || eventSubPath.startsWith("abstracts/");

  if (isAbstractsPath) {
    return addCorsHeaders(NextResponse.next(), origin);
  }

  const redirectUrl = req.nextUrl.clone();
  redirectUrl.pathname = `${pathname.split("/").slice(0, 3).join("/")}/abstracts`;

  return NextResponse.redirect(redirectUrl);
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
    "/my-registration/:path*",
    "/api/:path*",
  ],
};
