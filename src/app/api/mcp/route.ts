import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { validateApiKey } from "@/lib/api-key";
import { validateOAuthAccessToken } from "@/lib/mcp-oauth";
import { handlePreflight, withCors, publicBaseUrl } from "@/lib/mcp-cors";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { buildMcpServer } from "@/lib/agent/mcp-server-builder";

// ── Session store for stateful MCP clients (like n8n) ──────────────────────
const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; orgId: string; createdAt: number }>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id);
  }
}

async function authenticate(req: Request): Promise<{ organizationId: string; keyPrefix: string } | null> {
  const authHeader = req.headers.get("authorization");
  const apiKeyHeader = req.headers.get("x-api-key");
  const key = apiKeyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  if (!key) return null;

  // Try API-key path first (backward-compat for Claude Desktop + mcp-remote + n8n)
  const apiKey = await validateApiKey(key);
  if (apiKey) {
    return { organizationId: apiKey.organizationId, keyPrefix: key.slice(0, 12) };
  }

  // Fall back to OAuth 2.1 Bearer access token (claude.ai web, Anthropic Console)
  const oauth = await validateOAuthAccessToken(key);
  if (oauth) {
    return { organizationId: oauth.organizationId, keyPrefix: "oauth-" + key.slice(0, 10) };
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

  // Rate limit: 100 MCP requests per hour per API key / OAuth token
  const rl = checkRateLimit({
    key: `mcp-${authResult.keyPrefix}`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return withCors(
      req,
      new Response(
        JSON.stringify({ error: `Rate limit reached. Please wait ${rl.retryAfterSeconds} seconds.` }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  apiLogger.info({ msg: "MCP request", method: req.method, organizationId: authResult.organizationId, keyPrefix: authResult.keyPrefix });

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
  const mcpServer = buildMcpServer(authResult.organizationId);

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
  // Session termination
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
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
