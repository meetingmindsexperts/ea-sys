/**
 * CORS helpers for MCP OAuth + transport endpoints.
 *
 * claude.ai web, Anthropic Console, and any browser-based MCP client
 * fundamentally require CORS headers on both the MCP transport endpoint
 * AND all OAuth discovery/authorization endpoints. Without these, every
 * preflight is rejected by the browser and no traffic ever reaches our
 * server code.
 *
 * Usage in a route handler:
 *
 *   export async function OPTIONS(req: Request) {
 *     return handlePreflight(req);
 *   }
 *
 *   export async function POST(req: Request) {
 *     const res = NextResponse.json({ ... });
 *     return withCors(req, res);
 *   }
 */

const EXACT_ORIGINS = new Set<string>([
  "https://claude.ai",
  "https://console.anthropic.com",
]);

/** Claude has several subdomains (api.claude.ai, beta.claude.ai, etc). */
const SUBDOMAIN_SUFFIXES = [".claude.ai", ".anthropic.com"];

/** In dev, also allow localhost for manual curl testing. */
const DEV_ORIGINS = new Set<string>([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
]);

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (EXACT_ORIGINS.has(origin)) return true;
  if (process.env.NODE_ENV !== "production" && DEV_ORIGINS.has(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return SUBDOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Headers to attach to every CORS response (preflight + actual). */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = isOriginAllowed(origin);
  if (!allowed) {
    return {
      Vary: "Origin",
    };
  }
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-api-key, mcp-session-id, mcp-protocol-version, accept",
    "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Handle an OPTIONS preflight request. Returns 204 with CORS headers. */
export function handlePreflight(req: Request): Response {
  const origin = req.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

/**
 * Wrap an existing Response with CORS headers for the given request origin.
 * Returns a new Response (Response.headers is immutable after construction in
 * some runtimes, so we rebuild it).
 */
export function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
