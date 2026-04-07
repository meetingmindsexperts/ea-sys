import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { validateApiKey } from "@/lib/api-key";
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
  const result = await validateApiKey(key);
  if (!result) return null;
  return { organizationId: result.organizationId, keyPrefix: key.slice(0, 12) };
}

async function handleMcp(req: Request): Promise<Response> {
  const authResult = await authenticate(req);
  if (!authResult) {
    return new Response(JSON.stringify({ error: "Unauthorized. Provide API key via x-api-key header or Authorization: Bearer." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Rate limit: 100 MCP requests per hour per API key
  const rl = checkRateLimit({
    key: `mcp-${authResult.keyPrefix}`,
    limit: 100,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return new Response(JSON.stringify({ error: `Rate limit reached. Please wait ${rl.retryAfterSeconds} seconds.` }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  apiLogger.info({ msg: "MCP request", method: req.method, organizationId: authResult.organizationId, keyPrefix: authResult.keyPrefix });

  cleanExpiredSessions();

  // Check for existing session (stateful clients send Mcp-Session-Id header)
  const sessionId = req.headers.get("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    const response = await session.transport.handleRequest(req);
    return response;
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

  return response;
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
    return new Response(null, { status: 204 });
  }
  return handleMcp(req);
}
