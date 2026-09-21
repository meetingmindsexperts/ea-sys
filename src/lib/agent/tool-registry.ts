// The one answer to "which tools does this actor get".
//
// The MCP door has always built its tool list by calling registerAllMcpTools
// against a server: the core tools, then the CRM tools for roles canViewCrm
// admits, then the Budgets tools for roles canViewProcurement admits, each
// with a Zod parameter shape. The in-app Event Agent used to carry a second,
// hand-written JSON-schema list of 52 event-bound tools that could not reach
// the org-level ones (create_event, list_events, search_event, contacts) or
// the module tools at all.
//
// This file runs the same registration against a recording stub and hands
// back each tool with its JSON schema (from the Zod shape) and a runner, so
// both doors are served by one registration and cannot drift (architecture
// review §4.2, and Phase 4's "one schema per tool" by construction).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { registerAllMcpTools } from "./register-mcp-tools";
import type { AgentSource } from "./tools/_shared";
import { APPROVAL_CONFIRM_PARAM } from "./approvals";

export interface AgentActor {
  /** The signed-in person; stamped as the actor on every audit row. */
  userId: string;
  /** Session role; decides the CRM and Budgets tool sets. */
  role: string;
  /** API keys are admin-equivalent; the in-app door is never one. */
  fromApiKey: boolean;
}

export interface ToolRunResult {
  text: string;
  isError: boolean;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Tool["input_schema"];
  /** Validates the input against the tool's own Zod shape, then runs it. */
  run(input: Record<string, unknown>): Promise<ToolRunResult>;
}

type McpContent = { type: string; text?: string };
type McpToolResult = { content?: McpContent[]; isError?: boolean };
type McpToolCallback = (args: Record<string, unknown>, extra?: unknown) => Promise<McpToolResult> | McpToolResult;

function isZodShape(value: unknown): value is Record<string, z.ZodTypeAny> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((v) => v instanceof z.ZodType);
}

/** Anthropic wants an object schema; `$schema` is noise it does not accept. */
export function inputSchemaFromShape(shape: Record<string, z.ZodTypeAny>): Tool["input_schema"] {
  const json = z.toJSONSchema(z.object(shape), { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return { ...json, type: "object" } as Tool["input_schema"];
}

function textOf(result: McpToolResult): string {
  return (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`))
    .join("\n");
}

/**
 * Every tool this actor may call, in registration order, with a runner that
 * validates the model's input the way the MCP SDK would (a bad input is an
 * error result, never an exception into the loop).
 */
export function collectToolsForActor(opts: {
  organizationId: string;
  actor: AgentActor;
  source: AgentSource;
}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];

  const record = (...args: unknown[]) => {
    const name = String(args[0]);
    const cb = args[args.length - 1] as McpToolCallback;
    const description = typeof args[1] === "string" ? args[1] : "";
    const shapeArg = args.slice(1, -1).find(isZodShape);
    const shape = shapeArg ?? {};
    const schema = z.object(shape);
    tools.push({
      name,
      description,
      inputSchema: inputSchemaFromShape(shape),
      async run(input) {
        const parsed = schema.safeParse(input ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
          return { text: `Invalid input for ${name}: ${issues}`, isError: true };
        }
        const result = await cb(parsed.data as Record<string, unknown>);
        return { text: textOf(result), isError: Boolean(result.isError) };
      },
    });
  };

  const stub = {
    tool: record,
    registerTool: record,
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;

  registerAllMcpTools(stub, opts.organizationId, {
    systemUserId: opts.actor.userId,
    actor: { role: opts.actor.role, fromApiKey: opts.actor.fromApiKey },
    source: opts.source,
  });

  return tools;
}

/**
 * The shape the Anthropic Messages API takes. The MCP door's `confirm`
 * parameter is removed here: the in-app model must never learn a way to
 * approve its own call; the page's Approve click sets it (approvals.ts).
 */
export function toAnthropicTool(tool: RegisteredTool): Tool {
  const schema = tool.inputSchema as Tool["input_schema"] & { properties?: Record<string, unknown>; required?: string[] };
  if (!schema.properties || !(APPROVAL_CONFIRM_PARAM in schema.properties)) {
    return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
  }
  const { [APPROVAL_CONFIRM_PARAM]: _confirm, ...properties } = schema.properties;
  void _confirm;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      ...schema,
      properties,
      required: (schema.required ?? []).filter((r) => r !== APPROVAL_CONFIRM_PARAM),
    },
  };
}
