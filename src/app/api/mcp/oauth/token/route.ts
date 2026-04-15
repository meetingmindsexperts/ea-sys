import { NextResponse } from "next/server";
import {
  exchangeAuthCode,
  exchangeRefreshToken,
  getClient,
  verifyClientSecret,
} from "@/lib/mcp-oauth";
import { handlePreflight, withCors } from "@/lib/mcp-cors";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";

/**
 * OAuth 2.1 token endpoint (RFC 6749 §4.1.3 authorization_code grant +
 * §6 refresh_token grant).
 *
 * Accepts `application/x-www-form-urlencoded` body per spec. Returns the
 * standard token response shape: { access_token, token_type, expires_in,
 * refresh_token, scope }.
 *
 * The raw access_token and refresh_token are returned ONCE here and never
 * again. Storage is SHA-256 hashed.
 */

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    // Accept form-urlencoded per OAuth spec. Some clients send JSON — handle both.
    let body: URLSearchParams;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      body = new URLSearchParams(text);
    } else if (contentType.includes("application/json")) {
      const json = (await req.json().catch(() => ({}))) as Record<string, string>;
      body = new URLSearchParams(json);
    } else {
      const text = await req.text();
      body = new URLSearchParams(text);
    }

    const grantType = body.get("grant_type");
    const clientId = body.get("client_id");

    if (!grantType) {
      return withCors(
        req,
        NextResponse.json(
          { error: "invalid_request", error_description: "Missing grant_type" },
          { status: 400 },
        ),
      );
    }
    if (!clientId) {
      return withCors(
        req,
        NextResponse.json(
          { error: "invalid_client", error_description: "Missing client_id" },
          { status: 400 },
        ),
      );
    }

    // Per-client rate limit on the token endpoint
    const rl = checkRateLimit({
      key: `mcp-oauth-token:${clientId}`,
      limit: 60,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      return withCors(
        req,
        NextResponse.json(
          { error: "rate_limit_exceeded", error_description: "Too many token requests" },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        ),
      );
    }

    // Verify the client exists and the secret (if confidential)
    const client = await getClient(clientId);
    if (!client) {
      return withCors(
        req,
        NextResponse.json(
          { error: "invalid_client", error_description: "Unknown client_id" },
          { status: 401 },
        ),
      );
    }
    const providedSecret = body.get("client_secret") ?? undefined;
    if (!verifyClientSecret(client, providedSecret)) {
      return withCors(
        req,
        NextResponse.json(
          { error: "invalid_client", error_description: "Client authentication failed" },
          { status: 401 },
        ),
      );
    }

    // ── Dispatch on grant_type ──────────────────────────────────────
    if (grantType === "authorization_code") {
      const code = body.get("code");
      const codeVerifier = body.get("code_verifier");
      const redirectUri = body.get("redirect_uri");
      if (!code || !codeVerifier || !redirectUri) {
        return withCors(
          req,
          NextResponse.json(
            {
              error: "invalid_request",
              error_description: "code, code_verifier, and redirect_uri are required",
            },
            { status: 400 },
          ),
        );
      }

      const result = await exchangeAuthCode({ code, codeVerifier, clientId, redirectUri });
      if ("error" in result) {
        apiLogger.warn({ msg: "mcp-oauth:code-exchange-failed", clientId, error: result.error });
        return withCors(
          req,
          NextResponse.json(
            { error: result.error, error_description: result.description },
            { status: 400 },
          ),
        );
      }

      return withCors(
        req,
        NextResponse.json({
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scope,
        }),
      );
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.get("refresh_token");
      if (!refreshToken) {
        return withCors(
          req,
          NextResponse.json(
            { error: "invalid_request", error_description: "refresh_token is required" },
            { status: 400 },
          ),
        );
      }

      const result = await exchangeRefreshToken({ refreshToken, clientId });
      if ("error" in result) {
        apiLogger.warn({ msg: "mcp-oauth:refresh-failed", clientId, error: result.error });
        return withCors(
          req,
          NextResponse.json(
            { error: result.error, error_description: result.description },
            { status: 400 },
          ),
        );
      }

      return withCors(
        req,
        NextResponse.json({
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scope,
        }),
      );
    }

    return withCors(
      req,
      NextResponse.json(
        {
          error: "unsupported_grant_type",
          error_description: `grant_type '${grantType}' is not supported`,
        },
        { status: 400 },
      ),
    );
  } catch (err) {
    apiLogger.error({ err, msg: "mcp-oauth:token-failed" });
    return withCors(
      req,
      NextResponse.json(
        { error: "server_error", error_description: "Internal error in token endpoint" },
        { status: 500 },
      ),
    );
  }
}

export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
