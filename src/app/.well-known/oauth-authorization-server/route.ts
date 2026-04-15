import { NextResponse } from "next/server";
import { handlePreflight, withCors } from "@/lib/mcp-cors";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * Fetched by MCP clients (claude.ai web, etc.) after discovering this resource
 * via /.well-known/oauth-protected-resource. Lists the endpoints required for
 * Dynamic Client Registration, authorization, token exchange, and revocation.
 */
export async function GET(req: Request) {
  const base = new URL(req.url).origin;
  const body = {
    issuer: base,
    authorization_endpoint: `${base}/mcp-authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: `${base}/docs/MCP_REFERENCE.md`,
  };
  return withCors(req, NextResponse.json(body));
}

export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
