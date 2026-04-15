import crypto from "crypto";
import { db } from "./db";
import { apiLogger } from "./logger";

// ── Constants ──────────────────────────────────────────────────────────────

/** Access token TTL: 30 days */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Refresh token TTL: 90 days */
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Authorization code TTL: 10 minutes */
export const AUTH_CODE_TTL_SECONDS = 10 * 60;

/** Token prefixes — purely cosmetic but make tokens identifiable in logs */
const ACCESS_TOKEN_PREFIX = "mcp_at_";
const REFRESH_TOKEN_PREFIX = "mcp_rt_";
const AUTH_CODE_PREFIX = "mcp_ac_";

// ── Primitive helpers ──────────────────────────────────────────────────────

/** SHA-256 hex digest of a raw token — never store or log raw tokens. */
export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Generate a cryptographically random token with the given prefix. */
function generateToken(prefix: string, bytes = 32): string {
  return prefix + crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Verify a PKCE code_verifier against a stored code_challenge.
 * We only support S256 (plain is disallowed for security).
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

// ── Access token validation (hot path — called on every MCP request) ──────

/**
 * Validate a Bearer access token. Returns the associated org/user/client on success.
 * Returns null for unknown, expired, or revoked tokens. Also updates `lastUsedAt`
 * fire-and-forget so we don't block the request on the write.
 */
export async function validateOAuthAccessToken(raw: string): Promise<{
  organizationId: string;
  userId: string;
  clientId: string;
} | null> {
  if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(raw);
  const row = await db.mcpOAuthAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      clientId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt < new Date()) return null;

  // Fire-and-forget lastUsedAt update — don't block the request
  db.mcpOAuthAccessToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => apiLogger.warn({ err, msg: "mcp-oauth:lastUsedAt-update-failed", tokenId: row.id }));

  return {
    organizationId: row.organizationId,
    userId: row.userId,
    clientId: row.clientId,
  };
}

// ── Authorization code issuance + exchange ────────────────────────────────

/**
 * Issue a one-time authorization code for the given approved consent.
 * Called from the /authorize decision route after the user clicks "Approve".
 * Returns the raw code — the caller must include it in the redirect and NEVER log it.
 */
export async function issueAuthCode(params: {
  clientId: string;
  userId: string;
  organizationId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
}): Promise<string> {
  const raw = generateToken(AUTH_CODE_PREFIX);
  const codeHash = hashToken(raw);
  await db.mcpOAuthAuthCode.create({
    data: {
      codeHash,
      clientId: params.clientId,
      userId: params.userId,
      organizationId: params.organizationId,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      redirectUri: params.redirectUri,
      scope: params.scope,
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
    },
  });
  return raw;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export type OAuthExchangeError =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request"
  | "invalid_scope"
  | "unsupported_grant_type";

/**
 * Exchange an authorization code for access + refresh tokens.
 * Verifies PKCE, redirect_uri match, client_id match, and expiry.
 * On success, deletes the code row (one-time use) inside a transaction.
 */
export async function exchangeAuthCode(params: {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<OAuthTokenResult | { error: OAuthExchangeError; description?: string }> {
  if (!params.code.startsWith(AUTH_CODE_PREFIX)) {
    return { error: "invalid_grant", description: "Malformed authorization code" };
  }
  const codeHash = hashToken(params.code);
  const row = await db.mcpOAuthAuthCode.findUnique({
    where: { codeHash },
    select: {
      id: true,
      clientId: true,
      userId: true,
      organizationId: true,
      codeChallenge: true,
      codeChallengeMethod: true,
      redirectUri: true,
      scope: true,
      expiresAt: true,
    },
  });
  if (!row) {
    return { error: "invalid_grant", description: "Unknown or already-used authorization code" };
  }
  if (row.expiresAt < new Date()) {
    // Clean up the expired row to prevent reuse
    await db.mcpOAuthAuthCode.delete({ where: { id: row.id } }).catch(() => {});
    return { error: "invalid_grant", description: "Authorization code expired" };
  }
  if (row.clientId !== params.clientId) {
    return { error: "invalid_grant", description: "Client ID mismatch" };
  }
  if (row.redirectUri !== params.redirectUri) {
    return { error: "invalid_grant", description: "Redirect URI mismatch" };
  }
  if (!verifyPkce(params.codeVerifier, row.codeChallenge, row.codeChallengeMethod)) {
    return { error: "invalid_grant", description: "PKCE verification failed" };
  }

  // Mint tokens inside a transaction with the code deletion so we can't double-use.
  const rawAccess = generateToken(ACCESS_TOKEN_PREFIX);
  const rawRefresh = generateToken(REFRESH_TOKEN_PREFIX);

  const [, tokenRow] = await db.$transaction([
    db.mcpOAuthAuthCode.delete({ where: { id: row.id } }),
    db.mcpOAuthAccessToken.create({
      data: {
        tokenHash: hashToken(rawAccess),
        refreshHash: hashToken(rawRefresh),
        clientId: row.clientId,
        userId: row.userId,
        organizationId: row.organizationId,
        scope: row.scope,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      select: { id: true },
    }),
  ]);

  apiLogger.info({
    msg: "mcp-oauth:token-issued",
    tokenId: tokenRow.id,
    clientId: row.clientId,
    userId: row.userId,
    organizationId: row.organizationId,
  });

  return {
    accessToken: rawAccess,
    refreshToken: rawRefresh,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: row.scope,
  };
}

/**
 * Exchange a refresh token for a new access token (and rotate the refresh token).
 * On success, revokes the old row and mints a new one inside a transaction.
 */
export async function exchangeRefreshToken(params: {
  refreshToken: string;
  clientId: string;
}): Promise<OAuthTokenResult | { error: OAuthExchangeError; description?: string }> {
  if (!params.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) {
    return { error: "invalid_grant", description: "Malformed refresh token" };
  }
  const refreshHash = hashToken(params.refreshToken);
  const row = await db.mcpOAuthAccessToken.findUnique({
    where: { refreshHash },
    select: {
      id: true,
      clientId: true,
      userId: true,
      organizationId: true,
      scope: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  if (!row) {
    return { error: "invalid_grant", description: "Unknown refresh token" };
  }
  if (row.revokedAt) {
    return { error: "invalid_grant", description: "Refresh token revoked" };
  }
  // Refresh TTL = createdAt + REFRESH_TOKEN_TTL_SECONDS. We enforce it even though
  // the access token row's expiresAt only tracks the access token.
  const refreshExpires = row.createdAt.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000;
  if (refreshExpires < Date.now()) {
    return { error: "invalid_grant", description: "Refresh token expired" };
  }
  if (row.clientId !== params.clientId) {
    return { error: "invalid_grant", description: "Client ID mismatch" };
  }

  const rawAccess = generateToken(ACCESS_TOKEN_PREFIX);
  const rawRefresh = generateToken(REFRESH_TOKEN_PREFIX);

  const [, newRow] = await db.$transaction([
    db.mcpOAuthAccessToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    }),
    db.mcpOAuthAccessToken.create({
      data: {
        tokenHash: hashToken(rawAccess),
        refreshHash: hashToken(rawRefresh),
        clientId: row.clientId,
        userId: row.userId,
        organizationId: row.organizationId,
        scope: row.scope,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      select: { id: true },
    }),
  ]);

  apiLogger.info({
    msg: "mcp-oauth:token-refreshed",
    oldTokenId: row.id,
    newTokenId: newRow.id,
    clientId: row.clientId,
  });

  return {
    accessToken: rawAccess,
    refreshToken: rawRefresh,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    scope: row.scope,
  };
}

// ── Revocation ─────────────────────────────────────────────────────────────

/**
 * Revoke an access or refresh token. Per RFC 7009, always succeeds silently
 * even if the token is unknown — avoids enumeration attacks.
 */
export async function revokeToken(raw: string): Promise<void> {
  const hash = hashToken(raw);
  // Try both as access token and as refresh token
  await db.mcpOAuthAccessToken.updateMany({
    where: {
      OR: [{ tokenHash: hash }, { refreshHash: hash }],
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
}

// ── Client registration helpers ────────────────────────────────────────────

export interface RegisteredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
}

/**
 * Persist a new Dynamic Client Registration (RFC 7591) and return the generated
 * client_id + optional client_secret. Confidential clients get a secret; public
 * clients don't.
 */
export async function registerClient(params: {
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: "none" | "client_secret_post";
  scope?: string;
}): Promise<RegisteredClientInfo> {
  const clientId = crypto.randomUUID();
  const authMethod = params.tokenEndpointAuthMethod ?? "none";
  let rawSecret: string | undefined;
  let clientSecretHash: string | undefined;
  if (authMethod === "client_secret_post") {
    rawSecret = crypto.randomBytes(32).toString("base64url");
    clientSecretHash = hashToken(rawSecret);
  }

  await db.mcpOAuthClient.create({
    data: {
      clientId,
      clientSecretHash,
      clientName: params.clientName ?? null,
      redirectUris: params.redirectUris,
      grantTypes: params.grantTypes ?? ["authorization_code", "refresh_token"],
      tokenEndpointAuthMethod: authMethod,
      scope: params.scope ?? "mcp",
    },
  });

  return {
    clientId,
    clientSecret: rawSecret,
    clientName: params.clientName ?? null,
    redirectUris: params.redirectUris,
    grantTypes: params.grantTypes ?? ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: authMethod,
    scope: params.scope ?? "mcp",
  };
}

/**
 * Look up a client by clientId. Returns null if not found.
 * Used by /authorize and /token to validate incoming requests.
 */
export async function getClient(clientId: string): Promise<{
  clientId: string;
  clientSecretHash: string | null;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  scope: string;
} | null> {
  return db.mcpOAuthClient.findUnique({
    where: { clientId },
    select: {
      clientId: true,
      clientSecretHash: true,
      clientName: true,
      redirectUris: true,
      grantTypes: true,
      tokenEndpointAuthMethod: true,
      scope: true,
    },
  });
}

/**
 * Verify a client_secret for confidential clients.
 * Returns true for public clients (they don't need a secret).
 */
export function verifyClientSecret(
  client: { clientSecretHash: string | null; tokenEndpointAuthMethod: string },
  providedSecret: string | undefined,
): boolean {
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (!client.clientSecretHash || !providedSecret) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashToken(providedSecret)),
    Buffer.from(client.clientSecretHash),
  );
}
