/**
 * The three calls EA-SYS makes to Intuit's OAuth server (September 22, 2026):
 * swap an authorization code for tokens, refresh them, and revoke on
 * disconnect. Nothing here reads or writes the database; `connection.ts`
 * owns storage.
 *
 * Two Intuit behaviours the callers depend on. An access token lasts about
 * an hour, so a refresh is routine rather than exceptional. A refresh token
 * lasts about 100 days AND ROTATES: every refresh may hand back a new one,
 * and the previous one stops working, so a refresh that succeeds at Intuit
 * but fails to persist loses the connection. `refreshTokens` therefore
 * returns the whole set and the caller writes it before using it.
 */
import { apiLogger } from "@/lib/logger";
import {
  QBO_REVOKE_URL,
  QBO_SCOPE,
  QBO_TIMEOUT_MS,
  QBO_TOKEN_URL,
  QBO_AUTHORIZE_URL,
  type QuickBooksApp,
} from "./config";

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute instants, computed from Intuit's relative `expires_in`. */
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export type OAuthFailure = { ok: false; code: "HTTP_ERROR" | "NETWORK" | "MALFORMED"; message: string; status?: number };
export type OAuthResult = { ok: true; tokens: TokenSet } | OAuthFailure;

export function buildAuthorizeUrl(app: QuickBooksApp, state: string): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("scope", QBO_SCOPE);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

function basicAuth(app: QuickBooksApp): string {
  return `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
}

/** Intuit returns seconds; a missing or absurd value falls back to its documented default. */
function expiryFrom(seconds: unknown, fallbackSeconds: number, now: number): Date {
  const n = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
  return new Date(now + n * 1000);
}

async function tokenRequest(app: QuickBooksApp, body: URLSearchParams, what: string): Promise<OAuthResult> {
  let res: Response;
  try {
    res = await fetch(QBO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(app),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(QBO_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error({ msg: "quickbooks:token-request-network", what, err: message });
    return { ok: false, code: "NETWORK", message };
  }

  const text = await res.text();
  if (!res.ok) {
    // Intuit's body names the reason (invalid_grant on an expired refresh token,
    // invalid_client on the wrong environment's credentials). Never the token.
    apiLogger.error({ msg: "quickbooks:token-request-failed", what, status: res.status, body: text.slice(0, 400) });
    return { ok: false, code: "HTTP_ERROR", status: res.status, message: text.slice(0, 200) || `HTTP ${res.status}` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    apiLogger.error({ msg: "quickbooks:token-response-unparsable", what, body: text.slice(0, 200) });
    return { ok: false, code: "MALFORMED", message: "Intuit returned a token response that is not JSON" };
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  if (!accessToken || !refreshToken) {
    apiLogger.error({ msg: "quickbooks:token-response-incomplete", what, keys: Object.keys(parsed).join(",") });
    return { ok: false, code: "MALFORMED", message: "Intuit's token response carried no token" };
  }

  const now = Date.now();
  return {
    ok: true,
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: expiryFrom(parsed.expires_in, 3600, now),
      refreshTokenExpiresAt: expiryFrom(parsed.x_refresh_token_expires_in, 100 * 24 * 3600, now),
    },
  };
}

export function exchangeCode(app: QuickBooksApp, code: string): Promise<OAuthResult> {
  return tokenRequest(
    app,
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: app.redirectUri }),
    "exchange",
  );
}

export function refreshTokens(app: QuickBooksApp, refreshToken: string): Promise<OAuthResult> {
  return tokenRequest(app, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }), "refresh");
}

/**
 * Best-effort revocation. Never throws: the caller is disconnecting, and a
 * connection we cannot reach must still be removable from our side.
 */
export async function revokeToken(app: QuickBooksApp, token: string): Promise<boolean> {
  try {
    const res = await fetch(QBO_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: basicAuth(app), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(QBO_TIMEOUT_MS),
    });
    if (!res.ok) {
      apiLogger.warn({ msg: "quickbooks:revoke-failed", status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    apiLogger.warn({ msg: "quickbooks:revoke-error", err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
