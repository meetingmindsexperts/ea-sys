import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiKeyUseContext, validateApiKey } from "@/lib/api-key";
import { db } from "@/lib/db";
import { validateOAuthAccessToken } from "@/lib/mcp-oauth";
import { handlePreflight, withCors, publicBaseUrl } from "@/lib/mcp-cors";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { buildMcpServer } from "@/lib/agent/mcp-server-builder";
import { principalFromApiKey } from "@/lib/permissions/require-permission";
import { can, principalFromUser } from "@/lib/permissions/can";
import type { Grant } from "@/lib/permissions/system-roles";

// ── Session store for stateful MCP clients (like n8n) ──────────────────────
// A session is bound to the credential that opened it and to what that
// credential could do then (review L1, Oct 6, 2026). Reusing a session id with
// another credential is refused, and a credential whose role or grants changed
// is told to reconnect, so a narrowed key never keeps its old tool set.
const sessions = new Map<
  string,
  { transport: WebStandardStreamableHTTPServerTransport; orgId: string; credential: string; access: string; createdAt: number }
>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

/** What the session's server was built from: the actor's role and the key's grants. */
function accessFingerprint(a: AuthResult): string {
  return JSON.stringify([a.actorRole, a.fromApiKey, a.apiKeyGrants ?? null]);
}

/** A stale-session reply; spec-compliant clients reconnect on it. */
function sessionGone(req: Request, message: string): Response {
  return withCors(
    req,
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message }, id: null }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

type AuthResult = {
  organizationId: string;
  keyPrefix: string;
  /** What a session is bound to: the API key's id, or the OAuth person and client (tokens rotate on refresh). */
  credentialId: string;
  /**
   * The granting user's role for an OAuth grant; null for an API key.
   *
   * An API key is admin-minted, so null here means admin-equivalent — the
   * long-standing convention. An OAuth grant is NOT: `/mcp-authorize` admits
   * ORGANIZER, so without this the CRM tool set was handed to a role its own
   * export gate refuses (review H4).
   */
  actorRole: string | null;
  fromApiKey: boolean;
  rateLimitTier: "NORMAL" | "INTERNAL";
  /** ApiKey row id + the organiser's label; null on the OAuth path. What a human reads in /logs. */
  apiKeyId: string | null;
  apiKeyName: string | null;
  /** The key's role as grants (Phase 5); null for a key with no role (full) and on the OAuth path. */
  apiKeyGrants: Grant[] | null;
};

async function authenticate(req: Request): Promise<AuthResult | null> {
  const authHeader = req.headers.get("authorization");
  const apiKeyHeader = req.headers.get("x-api-key");
  const key = apiKeyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  if (!key) return null;

  // Try API-key path first (backward-compat for Claude Desktop + mcp-remote + n8n).
  // The validator logs `api-key:used` / `api-key:refused` with this context,
  // so every MCP call is attributable to a named key in /logs.
  const apiKey = await validateApiKey(key, apiKeyUseContext(req, "mcp"));
  if (apiKey) {
    return {
      organizationId: apiKey.organizationId,
      keyPrefix: apiKey.keyPrefix,
      credentialId: `key:${apiKey.apiKeyId}`,
      rateLimitTier: apiKey.rateLimitTier,
      actorRole: null,
      fromApiKey: true,
      apiKeyId: apiKey.apiKeyId,
      apiKeyName: apiKey.apiKeyName,
      apiKeyGrants: apiKey.grants,
    };
  }

  // Fall back to OAuth 2.1 Bearer access token (claude.ai web, Anthropic Console).
  // Tier comes from the parent McpOAuthClient row — defaults to NORMAL so a
  // leaked grant can never bypass the backstop. SUPER_ADMIN can flip the
  // client to INTERNAL after the user has connected once via DCR.
  const oauth = await validateOAuthAccessToken(key);
  if (oauth) {
    // Resolve the GRANTING user's current role — not the role they held when
    // they approved the grant. A demotion must take effect on the next request,
    // and a deleted user resolves to null, which fails closed everywhere the
    // CRM predicates are consulted.
    const grantee = await db.user.findUnique({
      where: { id: oauth.userId },
      select: { role: true, organizationId: true, deactivatedAt: true },
    });
    // A deactivated grantee is refused on every request (G6). Their tokens are
    // also revoked when they are deactivated; this covers a grant made before
    // that revocation existed, and any path that deactivates without it.
    if (grantee?.deactivatedAt) {
      apiLogger.warn({
        msg: "mcp:oauth-grantee-deactivated",
        organizationId: oauth.organizationId,
        userId: oauth.userId,
      });
      return null;
    }
    if (grantee && grantee.organizationId !== oauth.organizationId) {
      apiLogger.warn({
        msg: "mcp:oauth-grantee-org-mismatch",
        organizationId: oauth.organizationId,
        userId: oauth.userId,
      });
      return null;
    }
    // The grantee must STILL be allowed to connect (`mcp.connect`: admins
    // since Oct 6, 2026, and never through a custom role). A grant approved
    // before the rule narrowed, or by someone since demoted, stops here on
    // the next request, as a demotion does elsewhere.
    const mayConnect =
      !!grantee &&
      can(principalFromUser({ id: oauth.userId, role: grantee.role, organizationId: grantee.organizationId }), "mcp.connect");
    if (!mayConnect) {
      apiLogger.warn({
        msg: "mcp:oauth-grantee-cannot-connect",
        organizationId: oauth.organizationId,
        userId: oauth.userId,
        role: grantee?.role ?? null,
      });
      return null;
    }
    return {
      organizationId: oauth.organizationId,
      keyPrefix: "oauth-" + key.slice(0, 10),
      credentialId: `oauth:${oauth.userId}:${oauth.clientId}`,
      rateLimitTier: oauth.rateLimitTier,
      actorRole: grantee?.role ?? null,
      fromApiKey: false,
      apiKeyId: null,
      apiKeyName: null,
      // The OAuth door keeps its tool set (MCP-door parity parked, Sep 22).
      apiKeyGrants: null,
    };
  }

  return null;
}

/**
 * Build the RFC 6750 WWW-Authenticate challenge header pointing at our
 * OAuth protected-resource metadata so spec-compliant MCP clients (claude.ai
 * web, etc.) can discover the authorization server and start the OAuth flow.
 *
 * Uses `publicBaseUrl()` because `new URL(req.url).origin` inside a Docker
 * container behind nginx resolves to the internal address (e.g.
 * `http://0.0.0.0:3000`) rather than the public hostname — which breaks
 * discovery on every client.
 */
function wwwAuthenticate(req: Request): string {
  const base = publicBaseUrl(req);
  return `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}

async function handleMcp(req: Request): Promise<Response> {
  const authResult = await authenticate(req);
  if (!authResult) {
    // Emit the WWW-Authenticate challenge so spec-compliant clients (claude.ai
    // web, Anthropic Console) can discover the OAuth server and start the flow.
    // The existing x-api-key path for Claude Desktop / mcp-remote / n8n still
    // works; this just unblocks the browser-based clients.
    return withCors(
      req,
      new Response(
        JSON.stringify({
          error: "Unauthorized. Provide API key via x-api-key header, or OAuth Bearer token via Authorization header.",
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": wwwAuthenticate(req),
          },
        },
      ),
    );
  }

  // Rate limit: 100 MCP requests per hour per API key / OAuth token.
  // INTERNAL-tier keys (SUPER_ADMIN-issued, for trusted automation) bypass the
  // ceiling but every request is logged so a leaked key surfaces in `/logs`.
  const MCP_RATE_LIMIT = 100;
  const MCP_RATE_WINDOW_MS = 60 * 60 * 1000;
  if (authResult.rateLimitTier !== "INTERNAL") {
    const rl = checkRateLimit({
      key: `mcp-${authResult.keyPrefix}`,
      limit: MCP_RATE_LIMIT,
      windowMs: MCP_RATE_WINDOW_MS,
    });
    if (!rl.allowed) {
      apiLogger.warn(
        { msg: "MCP rate-limit rejection", keyPrefix: authResult.keyPrefix, retryAfterSeconds: rl.retryAfterSeconds },
        "mcp:rate-limited",
      );
      return withCors(
        req,
        new Response(
          JSON.stringify({
            error: `Rate limit exceeded: ${MCP_RATE_LIMIT} MCP requests per hour. Retry after ${rl.retryAfterSeconds}s.`,
            code: "RATE_LIMITED",
            retryAfterSeconds: rl.retryAfterSeconds,
            limit: MCP_RATE_LIMIT,
            windowSeconds: Math.floor(MCP_RATE_WINDOW_MS / 1000),
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(rl.retryAfterSeconds),
            },
          },
        ),
      );
    }
  } else {
    apiLogger.info({
      msg: "mcp:internal-key-used",
      keyPrefix: authResult.keyPrefix,
      apiKeyId: authResult.apiKeyId,
      apiKeyName: authResult.apiKeyName,
      organizationId: authResult.organizationId,
      method: req.method,
    });
  }

  apiLogger.info({
    msg: "MCP request",
    method: req.method,
    organizationId: authResult.organizationId,
    keyPrefix: authResult.keyPrefix,
    apiKeyId: authResult.apiKeyId,
    apiKeyName: authResult.apiKeyName,
    tier: authResult.rateLimitTier,
  });

  // Ensure Accept header includes text/event-stream (required by MCP SDK).
  // Some clients (n8n) only send Accept: application/json which causes a 406.
  const accept = req.headers.get("accept") || "";
  if (!accept.includes("text/event-stream")) {
    const headers = new Headers(req.headers);
    headers.set("accept", "application/json, text/event-stream");
    req = new Request(req, { headers });
  }

  cleanExpiredSessions();

  // Check for existing session (stateful clients send Mcp-Session-Id header)
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    if (session.orgId !== authResult.organizationId || session.credential !== authResult.credentialId) {
      apiLogger.warn({
        msg: "mcp:session-credential-mismatch",
        sessionId: sessionId.slice(0, 8),
        organizationId: authResult.organizationId,
        keyPrefix: authResult.keyPrefix,
      });
      return sessionGone(req, "This session belongs to another connection. Please reconnect the EA-SYS integration.");
    }
    if (session.access !== accessFingerprint(authResult)) {
      apiLogger.info({ msg: "mcp:session-access-changed", sessionId: sessionId.slice(0, 8), organizationId: authResult.organizationId, keyPrefix: authResult.keyPrefix });
      sessions.delete(sessionId);
      return sessionGone(req, "Your access changed. Please disconnect and reconnect the EA-SYS integration.");
    }
    const response = await session.transport.handleRequest(req);
    // Disable nginx buffering for SSE
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const headers = new Headers(response.headers);
      headers.set("X-Accel-Buffering", "no");
      headers.set("Cache-Control", "no-cache, no-transform");
      return withCors(req, new Response(response.body, { status: response.status, headers }));
    }
    return withCors(req, response);
  }

  // Client sent a session id that no longer exists server-side. Causes: the
  // in-memory sessions Map was wiped by a redeploy/container restart, the 30
  // min TTL elapsed, or memory pressure. Returning an explicit JSON-RPC error
  // instead of silently building a new transport (which would try to service a
  // mid-stream tools/call on a never-initialize'd session and surface as a
  // generic "Tool execution failed" to the user). claude.ai and other
  // spec-compliant clients will display the message and reconnect.
  if (sessionId) {
    apiLogger.warn({ msg: "MCP stale session id", sessionId: sessionId.slice(0, 8), organizationId: authResult.organizationId });
    return withCors(
      req,
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Session expired — please disconnect and reconnect the EA-SYS integration.",
          },
          id: null,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  // New session — create transport with session ID generation
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const mcpServer = buildMcpServer(
    authResult.organizationId,
    { role: authResult.actorRole, fromApiKey: authResult.fromApiKey },
    // A key with a role is gated by it (owner Oct 5, 2026: REST and MCP both).
    authResult.apiKeyGrants ? principalFromApiKey(authResult.organizationId, authResult.apiKeyGrants) : null,
  );

  await mcpServer.connect(transport);

  // Store session for subsequent requests
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const response = await transport.handleRequest(req);

  // After handling, store the session if one was created
  if (transport.sessionId) {
    sessions.set(transport.sessionId, {
      transport,
      orgId: authResult.organizationId,
      credential: authResult.credentialId,
      access: accessFingerprint(authResult),
      createdAt: Date.now(),
    });
  }

  // Disable nginx buffering for SSE responses (critical for MCP streaming)
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const headers = new Headers(response.headers);
    headers.set("X-Accel-Buffering", "no");
    headers.set("Cache-Control", "no-cache, no-transform");
    return withCors(req, new Response(response.body, { status: response.status, headers }));
  }

  return withCors(req, response);
}

export async function GET(req: Request) {
  return handleMcp(req);
}

export async function POST(req: Request) {
  return handleMcp(req);
}

export async function DELETE(req: Request) {
  // Session termination, by the credential that opened the session only
  // (review L1): a session id alone must not end someone else's session.
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    const authResult = await authenticate(req);
    const session = sessions.get(sessionId)!;
    if (!authResult || session.orgId !== authResult.organizationId || session.credential !== authResult.credentialId) {
      apiLogger.warn({ msg: "mcp:session-delete-refused", sessionId: sessionId.slice(0, 8), authenticated: !!authResult });
      return withCors(req, new Response(null, { status: authResult ? 404 : 401 }));
    }
    sessions.delete(sessionId);
    return withCors(req, new Response(null, { status: 204 }));
  }
  return handleMcp(req);
}

export async function OPTIONS(req: Request) {
  // CORS preflight — required for claude.ai web and any browser-based MCP
  // client. Without this, the browser blocks every subsequent request.
  return handlePreflight(req);
}
