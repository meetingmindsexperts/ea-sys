import { NextResponse } from "next/server";
import { handlePreflight, withCors } from "@/lib/mcp-cors";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Advertised via the `WWW-Authenticate: Bearer resource_metadata="..."` header
 * on 401 responses from /api/mcp. MCP clients (claude.ai web, etc.) fetch this
 * document to discover the authorization server(s) that protect the resource.
 */
export async function GET(req: Request) {
  const base = new URL(req.url).origin;
  const body = {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "EA-SYS MCP Server",
    resource_documentation: `${base}/docs/MCP_REFERENCE.md`,
  };
  return withCors(req, NextResponse.json(body));
}

export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
