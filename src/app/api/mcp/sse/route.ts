/**
 * MCP SSE Transport Endpoint
 *
 * Bridges SSE-based MCP clients to the Streamable HTTP transport.
 * GET  /api/mcp/sse → returns connection info pointing to the Streamable HTTP endpoint
 *
 * Most modern MCP clients use Streamable HTTP (/api/mcp) directly.
 * This endpoint exists for backward compatibility with older clients
 * that only support SSE transport.
 */

import { NextResponse } from "next/server";

export async function GET() {
  // Direct SSE-only clients to the Streamable HTTP endpoint
  return NextResponse.json({
    message: "EA-SYS MCP Server",
    transport: "streamable-http",
    endpoint: "/api/mcp",
    instructions: "This server uses Streamable HTTP transport. Send MCP requests via POST /api/mcp with x-api-key header.",
    docs: "See docs/MCP_REFERENCE.md for connection instructions.",
  });
}
