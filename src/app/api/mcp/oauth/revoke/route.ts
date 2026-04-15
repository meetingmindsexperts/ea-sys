import { NextResponse } from "next/server";
import { revokeToken } from "@/lib/mcp-oauth";
import { handlePreflight, withCors } from "@/lib/mcp-cors";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * OAuth 2.0 Token Revocation (RFC 7009).
 *
 * Always returns 200 even for unknown tokens — per spec, this avoids token
 * enumeration attacks. Accepts either form-urlencoded or JSON body.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = checkRateLimit({
      key: `mcp-oauth-revoke:${ip}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return withCors(
        req,
        NextResponse.json(
          { error: "rate_limit_exceeded" },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        ),
      );
    }

    const contentType = req.headers.get("content-type") ?? "";
    let body: URLSearchParams;
    if (contentType.includes("application/json")) {
      const json = (await req.json().catch(() => ({}))) as Record<string, string>;
      body = new URLSearchParams(json);
    } else {
      const text = await req.text();
      body = new URLSearchParams(text);
    }

    const token = body.get("token");
    if (token) {
      await revokeToken(token);
      apiLogger.info({ msg: "mcp-oauth:token-revoked", tokenPrefix: token.slice(0, 12) });
    }

    // Always 200 regardless of whether the token existed
    return withCors(req, new NextResponse(null, { status: 200 }));
  } catch (err) {
    apiLogger.error({ err, msg: "mcp-oauth:revoke-failed" });
    // Still return 200 per spec — failures are not surfaced
    return withCors(req, new NextResponse(null, { status: 200 }));
  }
}

export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
