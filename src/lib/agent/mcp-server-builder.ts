/**
 * Shared MCP server builder used by the Streamable HTTP transport.
 * Thin wrapper: creates a McpServer, delegates to registerAllMcpTools().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllMcpTools } from "./register-mcp-tools";
import pkg from "../../../package.json";

// Re-export so existing callers don't break
export type { AgentContext } from "./tools/_shared";

// Serves as a best-effort cache-invalidation hint to MCP clients. Bump
// `package.json` version on every commit that adds/changes MCP tools so
// connected clients (claude.ai web especially) may re-fetch the tool list.
const MCP_SERVER_VERSION = pkg.version;

/**
 * Build an org-scoped MCP server. All tools are restricted to the authenticated organization.
 * @param organizationId - The org ID from the validated API key. ALL queries are scoped to this org.
 */
export function buildMcpServer(organizationId: string): McpServer {
  const server = new McpServer({ name: "ea-sys", version: MCP_SERVER_VERSION });
  registerAllMcpTools(server, organizationId);
  return server;
}
