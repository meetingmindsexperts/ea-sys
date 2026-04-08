/**
 * Zoom Server-to-Server OAuth client.
 * Handles token management with in-memory caching and API request wrapper.
 * Reuses encryptSecret/decryptSecret from eventsair-client.ts.
 */

import { encryptSecret, decryptSecret } from "@/lib/eventsair-client";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import type { ZoomOAuthTokenResponse, ZoomOrgCredentials, ZoomApiError } from "./types";

// ── Constants ──────────────────────────────────────────────────────

const ZOOM_OAUTH_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";
const FETCH_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// ── Token cache ────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();

// ── Fetch with timeout ─────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Zoom API request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Credential helpers ─────────────────────────────────────────────

export { encryptSecret, decryptSecret };

export async function getZoomCredentials(organizationId: string): Promise<ZoomOrgCredentials | null> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });

  if (!org?.settings || typeof org.settings !== "object") return null;

  const settings = org.settings as Record<string, unknown>;
  const zoom = settings.zoom as ZoomOrgCredentials | undefined;

  if (!zoom?.accountId || !zoom?.clientId || !zoom?.clientSecretEncrypted) return null;

  return zoom;
}

export async function isZoomConfigured(organizationId: string): Promise<boolean> {
  const creds = await getZoomCredentials(organizationId);
  return creds !== null;
}

// ── OAuth token fetch ──────────────────────────────────────────────

async function fetchAccessToken(credentials: ZoomOrgCredentials): Promise<CachedToken> {
  const clientSecret = decryptSecret(credentials.clientSecretEncrypted);
  const basicAuth = Buffer.from(`${credentials.clientId}:${clientSecret}`).toString("base64");

  const startMs = Date.now();
  const response = await fetchWithTimeout(ZOOM_OAUTH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: credentials.accountId,
    }),
  });

  const durationMs = Date.now() - startMs;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    apiLogger.error(
      { statusCode: response.status, error: errorText, durationMs },
      "zoom:oauth-token-failed"
    );
    throw new Error(`Zoom OAuth token request failed: ${response.status} ${errorText}`);
  }

  const data: ZoomOAuthTokenResponse = await response.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  apiLogger.info(
    { expiresIn: data.expires_in, durationMs },
    "zoom:oauth-token-refreshed"
  );

  return { accessToken: data.access_token, expiresAt };
}

// ── Get valid access token (with cache) ────────────────────────────

export async function getZoomAccessToken(organizationId: string): Promise<string> {
  const cached = tokenCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    apiLogger.debug({ organizationId, ttlMs: cached.expiresAt - Date.now() }, "zoom:token-cache-hit");
    return cached.accessToken;
  }

  const credentials = await getZoomCredentials(organizationId);
  if (!credentials) {
    throw new Error("Zoom credentials not configured for this organization");
  }

  const token = await fetchAccessToken(credentials);
  tokenCache.set(organizationId, token);
  return token.accessToken;
}

// ── Generic Zoom API request ───────────────────────────────────────

export async function zoomApiRequest<T>(
  organizationId: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const accessToken = await getZoomAccessToken(organizationId);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const startMs = Date.now();
  const response = await fetchWithTimeout(`${ZOOM_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const durationMs = Date.now() - startMs;

  apiLogger.info(
    { method, path, statusCode: response.status, durationMs },
    "zoom:api-call"
  );

  // DELETE returns 204 with no body
  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    let errorBody: ZoomApiError | undefined;
    try {
      errorBody = await response.json();
    } catch {
      // ignore parse errors
    }

    apiLogger.error(
      {
        method,
        path,
        statusCode: response.status,
        zoomErrorCode: errorBody?.code,
        zoomMessage: errorBody?.message,
        durationMs,
      },
      "zoom:api-error"
    );

    throw new Error(
      `Zoom API error: ${response.status} ${errorBody?.message || "Unknown error"} (code: ${errorBody?.code || "N/A"})`
    );
  }

  return response.json();
}
