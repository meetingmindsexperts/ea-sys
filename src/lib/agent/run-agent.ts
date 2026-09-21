// The Event Agent's loop, shared by the org-level route and the per-event
// alias. One place decides which tools the actor gets (the registry), what
// the model is told (the prompt), what runs (the gate) and how a result
// reaches the model (as data). The routes own authentication, the role
// gate, the rate limit and the SSE framing.

import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, MessageStreamEvent, ToolUnion, WebSearchTool20250305 } from "@anthropic-ai/sdk/resources/messages";
import { apiLogger } from "@/lib/logger";
import { resolveAnthropicApiKey } from "@/lib/ai/credentials";
import { getModelConfig } from "@/lib/ai/config";
import { redactFinancialFields } from "@/lib/finance-visibility";
import { buildSystemPrompt } from "./system-prompt";
import { gateToolCall } from "./tool-gate";
import { wrapToolResultAsData } from "./tool-result";
import { collectToolsForActor, toAnthropicTool, type AgentActor, type RegisteredTool } from "./tool-registry";

export const MAX_TURNS = 25;

// Anthropic-hosted web search. Anthropic runs it server-side and inlines the
// results; the loop only handles client tool_use blocks. $10 per 1,000
// searches, capped at 3 per request. The org admin must enable web search
// in the Claude Console or the call returns { error_code: "unavailable" }.
const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
};

export type AgentSseEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input: unknown; toolUseId: string }
  | { type: "tool_result"; name: string; result: unknown; toolUseId: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface AgentRequest {
  organizationId: string;
  /** The event the page was opened from, or null for the org-level door. */
  eventId: string | null;
  actor: AgentActor;
  message: string;
  history: MessageParam[];
  /** MEMBER: every non-read tool is refused. */
  readOnly: boolean;
  /** Roles outside canViewFinance: money is refused or redacted. */
  blockFinance: boolean;
  send: (event: AgentSseEvent) => void;
}

/** What the loop needs from the model: async events, then the final message. */
export type ModelStream = AsyncIterable<MessageStreamEvent> & { finalMessage(): Promise<Message> };
export type ModelStreamParams = Parameters<Anthropic["messages"]["stream"]>[0];

export interface AgentDeps {
  /** Test seam: replaces anthropic.messages.stream. */
  createStream?: (params: ModelStreamParams) => ModelStream;
  /** Test seam: replaces the registry for this actor. */
  tools?: RegisteredTool[];
}

/** A JSON tool result is redacted like any other payload; text stays text. */
export function redactToolText(text: string): string {
  try {
    return JSON.stringify(redactFinancialFields(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

function parseForClient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runAgentRequest(req: AgentRequest, deps: AgentDeps = {}): Promise<void> {
  const tools = deps.tools ?? collectToolsForActor({ organizationId: req.organizationId, actor: req.actor, source: "agent" });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const definitions = tools.map(toAnthropicTool);

  const systemPrompt = await buildSystemPrompt({
    organizationId: req.organizationId,
    eventId: req.eventId,
    readOnly: req.readOnly,
    tools: definitions,
  });

  // The tool list and the prompt are the same on every turn of a request
  // and across requests from the same org, so both are cache candidates:
  // the cache_control on the last tool covers every tool before it.
  const anthropicTools: ToolUnion[] = definitions.map((d, i) =>
    i === definitions.length - 1 ? { ...d, cache_control: { type: "ephemeral" } } : d,
  );
  anthropicTools.push(WEB_SEARCH_TOOL);

  const messages: MessageParam[] = [...req.history, { role: "user", content: req.message }];

  const createStream =
    deps.createStream ??
    (() => {
      let client: Anthropic | null = null;
      return async (params: ModelStreamParams) => {
        // Org-resolved key: the org's own Anthropic account when one is
        // configured, the environment key otherwise.
        client ??= new Anthropic({ apiKey: await resolveAnthropicApiKey(req.organizationId) });
        return client.messages.stream(params);
      };
    })();
  const modelConfig = getModelConfig("agent");

  let writesSoFar = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = await createStream({
      model: modelConfig.model,
      max_tokens: modelConfig.maxTokens,
      temperature: modelConfig.temperature,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: anthropicTools,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        req.send({ type: "text_delta", text: event.delta.text });
      }
    }

    const response = await stream.finalMessage();
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") return;
    if (response.stop_reason !== "tool_use") return;

    const toolResults: MessageParam["content"] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolName = block.name;
      const toolInput = (block.input ?? {}) as Record<string, unknown>;
      req.send({ type: "tool_start", name: toolName, input: toolInput, toolUseId: block.id });

      const started = Date.now();
      const tool = byName.get(toolName);
      let text: string;
      let isError: boolean;

      const decision = tool ? gateToolCall(toolName, { readOnly: req.readOnly, blockFinance: req.blockFinance, writesSoFar }) : null;
      if (!tool || decision === null) {
        text = JSON.stringify({ error: `Unknown tool: ${toolName}`, code: "UNKNOWN_TOOL" });
        isError = true;
      } else if (decision.kind === "refuse") {
        text = JSON.stringify(decision.result);
        isError = true;
      } else {
        if (decision.write) writesSoFar++;
        const ran = await tool.run(toolInput);
        text = req.blockFinance ? redactToolText(ran.text) : ran.text;
        isError = ran.isError;
      }

      const durationMs = Date.now() - started;
      const log = {
        tool: toolName,
        eventId: req.eventId,
        organizationId: req.organizationId,
        userId: req.actor.userId,
        source: "agent" as const,
        durationMs,
      };
      if (isError) apiLogger.warn({ msg: "agent tool validation-error", ...log, err: text.slice(0, 500) });
      else apiLogger.info({ msg: "agent tool call", ...log });

      req.send({ type: "tool_result", name: toolName, result: parseForClient(text), toolUseId: block.id });

      if (Array.isArray(toolResults)) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: wrapToolResultAsData(toolName, text),
          ...(isError ? { is_error: true } : {}),
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  req.send({
    type: "error",
    message: "The agent reached its maximum number of steps. Please try a simpler request or break it into smaller parts.",
  });
}
