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
/**
 * `actor` carries what the CALLER may do. Omitted ⇒ admin-equivalent, which is
 * correct for an API key (admin-minted) and was the ONLY assumption this builder
 * made — including for OAuth grants, where `/mcp-authorize` admits ORGANIZER. A
 * role the CRM's export gate refuses could therefore approve its own consent
 * screen and get the full CRM tool set with deal values (review H4).
 */
export function buildMcpServer(
  organizationId: string,
  actor?: { role: string | null; fromApiKey: boolean },
): McpServer {
  const server = new McpServer({ name: "ea-sys", version: MCP_SERVER_VERSION });
  registerAllMcpTools(server, organizationId, actor ? { actor } : undefined);
  return server;
}
