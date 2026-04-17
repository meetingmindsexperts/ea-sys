#!/usr/bin/env node
/**
 * EA-SYS MCP Server — stdio transport.
 *
 * Connects directly to the database via Prisma — no HTTP proxy.
 * Uses the shared registerAllMcpTools() so it always stays in sync
 * with the HTTP transport.
 *
 * IMPORTANT: Stdio transport uses stdout for MCP messages.
 * ALL application logging MUST go to stderr to avoid corrupting the protocol.
 *
 * Usage:
 *   npx tsx src/mcp/server.ts
 */

// Force all Pino logging to stderr BEFORE any imports touch the logger
process.env.MCP_STDIO_MODE = "1";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllMcpTools } from "../lib/agent/register-mcp-tools.js";
import { db } from "../lib/db.js";
import pkg from "../../package.json";

async function main() {
  const org = await db.organization.findFirst({ select: { id: true } });
  if (!org) {
    console.error("No organization found in database.");
    process.exit(1);
  }

  const server = new McpServer({ name: "ea-sys", version: pkg.version });
  registerAllMcpTools(server, org.id, { systemUserId: "mcp-remote" });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("EA-SYS MCP server running on stdio");
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
