import { createHash, randomBytes } from "crypto";
import { ApiKeyRateLimitTier } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";

const PREFIX = "mmg_";

export type RateLimitTier = ApiKeyRateLimitTier;

/** Generate a new plaintext API key — returned once to the caller, never stored. */
export function generateApiKey(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

/** SHA-256 hash of the full key string — stored in the database. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The first 12 chars of the key (prefix + 8 chars) used for display. */
export function keyPrefix(key: string): string {
  return key.slice(0, 12);
}

/**
 * Where an API key was presented. `mcp` is the JSON-RPC front door at
 * /api/mcp; `rest` is every route that resolves the caller through
 * `getOrgContext` (events, contacts, speakers, registrations, ...).
 */
export type ApiKeySurface = "mcp" | "rest";

/**
 * The request facts recorded on every API-key use, so "which key, when, from
 * where, for what" is answerable from /logs without a database session.
 *
 * Build it with `apiKeyUseContext(req, surface)`; the two callers must not
 * hand-roll this or the two log shapes drift.
 */
export interface ApiKeyUseContext {
  surface: ApiKeySurface;
  method: string;
  /** Pathname ONLY, never the query string: `?q=` on the registrations list can carry an email. */
  route: string;
  ip: string;
  userAgent: string | null;
}

const USER_AGENT_MAX = 200;

/** Derive the loggable request facts for an API-key use. One implementation for both callers. */
export function apiKeyUseContext(req: Request, surface: ApiKeySurface): ApiKeyUseContext {
  let route = "unknown";
  try {
    route = new URL(req.url).pathname;
  } catch {
    // A malformed URL is not this helper's problem; the request already
    // reached a handler, so the router accepted it. Log what we have.
  }
  const ua = req.headers.get("user-agent");
  return {
    surface,
    method: req.method,
    route,
    ip: getClientIp(req),
    userAgent: ua ? ua.slice(0, USER_AGENT_MAX) : null,
  };
}

export interface ValidatedApiKey {
  organizationId: string;
  rateLimitTier: RateLimitTier;
  /** The ApiKey row id, the stable identity a rotated key keeps in the log. */
  apiKeyId: string;
  /** The organiser's own label for the key ("n8n Webflow sync"), what a human reads in /logs. */
  apiKeyName: string;
  /** The STORED display prefix (`mmg_` + 8 chars), what Settings → API Keys shows. Never the credential. */
  keyPrefix: string;
}

/**
 * Validate an API key from a request header. Returns the organizationId,
 * rateLimitTier and the key's identity, or null.
 *
 * EVERY outcome for an `mmg_`-shaped credential is logged (Sep 4, 2026):
 *
 *   - a successful use logs `api-key:used` at INFO with the key's id, name and
 *     display prefix plus the request context, so the question "which key is
 *     being used, when, from where, for what" is answerable from /logs
 *     (file source on EC2, plus CloudWatch for 30 days) without psql. Until
 *     this line existed the only trace was `ApiKey.lastUsedAt`, which keeps the
 *     LAST timestamp and nothing else, and the REST path through
 *     `getOrgContext` logged nothing at all.
 *   - a REFUSED credential logs `api-key:refused` at WARN with the reason
 *     (unknown / inactive / expired). Warn is deliberate: after a leaked key is
 *     rotated, the integrations still presenting the OLD key are exactly what
 *     an operator needs to see, and warn is the level that reaches the
 *     SystemLog table and the /admin/infra abuse card. Only the 12-char
 *     display prefix is logged, never the credential and never its hash.
 *
 * A string that is not `mmg_`-shaped returns null silently and touches no
 * database: `getOrgContext` and /api/mcp both pass mobile JWTs and OAuth
 * tokens through here first, and those are not API-key failures.
 *
 * `ctx` is optional so a caller with no request in hand (tests, a script)
 * still gets the validation; the line then carries no route or ip.
 */
export async function validateApiKey(
  rawKey: string,
  ctx?: ApiKeyUseContext,
): Promise<ValidatedApiKey | null> {
  if (!rawKey.startsWith(PREFIX)) return null;

  const hash = hashApiKey(rawKey);
  const displayPrefix = keyPrefix(rawKey);

  const apiKey = await db.apiKey.findUnique({
    where: { keyHash: hash },
    select: {
      id: true,
      organizationId: true,
      name: true,
      prefix: true,
      isActive: true,
      expiresAt: true,
      rateLimitTier: true,
    },
  });

  if (!apiKey) {
    apiLogger.warn({ msg: "api-key:refused", reason: "unknown", keyPrefix: displayPrefix, ...ctx });
    return null;
  }
  if (!apiKey.isActive) {
    apiLogger.warn({
      msg: "api-key:refused",
      reason: "inactive",
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      organizationId: apiKey.organizationId,
      ...ctx,
    });
    return null;
  }
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    apiLogger.warn({
      msg: "api-key:refused",
      reason: "expired",
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      organizationId: apiKey.organizationId,
      expiresAt: apiKey.expiresAt.toISOString(),
      ...ctx,
    });
    return null;
  }

  apiLogger.info({
    msg: "api-key:used",
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    keyPrefix: apiKey.prefix,
    organizationId: apiKey.organizationId,
    tier: apiKey.rateLimitTier,
    ...ctx,
  });

  // Update lastUsedAt non-blocking
  db.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => apiLogger.error({ err, msg: "Failed to update API key lastUsedAt", apiKeyId: apiKey.id }));

  return {
    organizationId: apiKey.organizationId,
    rateLimitTier: apiKey.rateLimitTier,
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
    keyPrefix: apiKey.prefix,
  };
}
