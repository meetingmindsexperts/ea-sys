import { NextResponse } from "next/server";
import { z } from "zod";
import { registerClient } from "@/lib/mcp-oauth";
import { handlePreflight, withCors } from "@/lib/mcp-cors";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit, getClientIp } from "@/lib/security";

/**
 * RFC 7591 Dynamic Client Registration endpoint.
 *
 * claude.ai (and every spec-compliant remote MCP client) POSTs here on first
 * connection to register itself and receive a client_id. We accept any valid
 * DCR request with at least one redirect_uri. Optional fields default to
 * sensible values for the MCP flow.
 *
 * No authentication is required — that's how RFC 7591 works — but we do
 * rate-limit per IP to prevent abuse.
 */

const registerRequestSchema = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .optional(),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_post"])
    .optional(),
  scope: z.string().max(200).optional(),
  // These fields are accepted for spec compliance but we don't act on them.
  response_types: z.array(z.string()).optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const rl = checkRateLimit({
      key: `mcp-oauth-register:${ip}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({ msg: "mcp-oauth:register-rate-limited", ip });
      return withCors(
        req,
        NextResponse.json(
          { error: "rate_limit_exceeded", error_description: "Max 10 registrations per hour per IP" },
          { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
        ),
      );
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return withCors(
        req,
        NextResponse.json(
          { error: "invalid_client_metadata", error_description: "Request body must be valid JSON" },
          { status: 400 },
        ),
      );
    }

    const parsed = registerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return withCors(
        req,
        NextResponse.json(
          {
            error: "invalid_client_metadata",
            error_description: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
          { status: 400 },
        ),
      );
    }

    const client = await registerClient({
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
      grantTypes: parsed.data.grant_types,
      tokenEndpointAuthMethod: parsed.data.token_endpoint_auth_method,
      scope: parsed.data.scope,
    });

    apiLogger.info({
      msg: "mcp-oauth:client-registered",
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUris: client.redirectUris,
      authMethod: client.tokenEndpointAuthMethod,
      ip,
    });

    // RFC 7591 response shape
    return withCors(
      req,
      NextResponse.json(
        {
          client_id: client.clientId,
          ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          grant_types: client.grantTypes,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          scope: client.scope,
        },
        { status: 201 },
      ),
    );
  } catch (err) {
    apiLogger.error({ err, msg: "mcp-oauth:register-failed" });
    return withCors(
      req,
      NextResponse.json(
        { error: "server_error", error_description: "Internal error during client registration" },
        { status: 500 },
      ),
    );
  }
}

export async function OPTIONS(req: Request) {
  return handlePreflight(req);
}
