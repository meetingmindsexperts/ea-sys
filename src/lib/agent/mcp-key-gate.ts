import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiLogger } from "@/lib/logger";
import { can, canEverywhere, type EventFacts, type Principal } from "@/lib/permissions/can";
import { describePermission, type PermissionKey } from "@/lib/permissions/catalogue";
import { loadEventFacts } from "./event-facts-loader";
import { gateToolCall } from "./tool-gate";
import { toolPermission } from "./tool-permissions";

/** The key each MCP resource reads with (the matching list routes' keys). */
const RESOURCE_PERMISSIONS: Readonly<Record<string, PermissionKey>> = {
  "events-list": "events.read",
  "event-info": "events.read",
  "event-registrations-summary": "registrations.read",
  "event-speakers": "speakers.read",
  "event-agenda": "sessions.read",
  "event-abstracts-summary": "abstracts.read",
};

/**
 * The MCP door for an API key that acts with a role (custom roles Phase 5,
 * owner Oct 5, 2026: "REST and MCP both"). Wraps the server so that:
 *  - a tool or resource registers only when the role holds its key somewhere,
 *    so the client's tool list shows what the key can do;
 *  - every call is judged on the event it names, exactly as the agent's gate
 *    (`gateToolCall`), since a role can be scoped to assigned or webinar
 *    events, and can change while a client stays connected.
 * Prompts carry no data and pass through. A key with no role, and the OAuth
 * door, never come here: they keep the full tool set (parked Sep 22).
 */
export function gateMcpServerForKey(server: McpServer, principal: Principal, organizationId: string): McpServer {
  const factsFor = async (key: PermissionKey, eventId: unknown): Promise<EventFacts | null | undefined> => {
    if (!describePermission(key)?.eventBound || typeof eventId !== "string" || !eventId) return undefined;
    return loadEventFacts(eventId, organizationId);
  };

  const refusal = (name: string, code: string, error: string) => {
    apiLogger.warn({ msg: "mcp:key-role-refused", tool: name, code, organizationId });
    return { content: [{ type: "text" as const, text: JSON.stringify({ error, code }) }], isError: true as const };
  };

  const tool = (...args: unknown[]) => {
    const name = String(args[0]);
    const key = toolPermission(name);
    if (!key || !can(principal, key)) return undefined;
    const run = args[args.length - 1] as (...callArgs: unknown[]) => unknown;
    args[args.length - 1] = async (...callArgs: unknown[]) => {
      const input = (callArgs.length > 1 ? callArgs[0] : {}) as Record<string, unknown>;
      const decision = gateToolCall(name, { principal, event: await factsFor(key, input?.eventId), writesSoFar: 0, maxWrites: Number.MAX_SAFE_INTEGER, input });
      if (decision.kind === "refuse") return refusal(name, decision.result.code, decision.result.error);
      return run(...callArgs);
    };
    return (server.tool as (...a: unknown[]) => unknown)(...args);
  };

  const resource = (...args: unknown[]) => {
    const name = String(args[0]);
    const key = RESOURCE_PERMISSIONS[name];
    if (!key || !can(principal, key)) return undefined;
    const read = args[args.length - 1] as (...callArgs: unknown[]) => unknown;
    args[args.length - 1] = async (...callArgs: unknown[]) => {
      const params = (callArgs[1] ?? {}) as Record<string, unknown>;
      const facts = await factsFor(key, params.eventId);
      // No event named: the key must hold for every event (review M5).
      const allowed = facts === undefined ? canEverywhere(principal, key) : can(principal, key, { event: facts });
      if (!allowed) {
        apiLogger.warn({ msg: "mcp:key-role-refused", resource: name, organizationId });
        throw new Error(`This API key's role does not include "${name}" for that event.`);
      }
      return read(...callArgs);
    };
    return (server.resource as (...a: unknown[]) => unknown)(...args);
  };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return tool;
      if (prop === "resource") return resource;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export { RESOURCE_PERMISSIONS };
