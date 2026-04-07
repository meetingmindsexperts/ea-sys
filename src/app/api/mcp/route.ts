import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { validateApiKey } from "@/lib/api-key";
import { apiLogger } from "@/lib/logger";
import { buildMcpServer } from "@/lib/agent/mcp-server-builder";

async function authenticate(req: Request): Promise<{ organizationId: string } | null> {
  const authHeader = req.headers.get("authorization");
  const apiKeyHeader = req.headers.get("x-api-key");
  const key = apiKeyHeader || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  if (!key) return null;
  return validateApiKey(key);
}

async function handleMcp(req: Request): Promise<Response> {
  const authResult = await authenticate(req);
  if (!authResult) {
    return new Response(JSON.stringify({ error: "Unauthorized. Provide API key via x-api-key header or Authorization: Bearer." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcpServer = buildMcpServer();

  await mcpServer.connect(transport);
  const response = await transport.handleRequest(req);
  return response;
}

export async function GET(req: Request) {
  apiLogger.info({ msg: "MCP GET request received" });
  return handleMcp(req);
}

export async function POST(req: Request) {
  return handleMcp(req);
}

export async function DELETE(req: Request) {
  return handleMcp(req);
}
