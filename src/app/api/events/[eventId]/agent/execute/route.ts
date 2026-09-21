import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ToolUnion, WebSearchTool20250305 } from "@anthropic-ai/sdk/resources/messages";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { db } from "@/lib/db";
import { AGENT_TOOL_DEFINITIONS, TOOL_EXECUTOR_MAP } from "@/lib/agent/event-tools";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import { gateToolCall } from "@/lib/agent/tool-gate";
import { wrapToolResultAsData } from "@/lib/agent/tool-result";
import { resolveAnthropicApiKey } from "@/lib/ai/credentials";
import { getModelConfig } from "@/lib/ai/config";
import { canViewFinance, redactFinancialFields } from "@/lib/finance-visibility";
import type { AgentContext } from "@/lib/agent/event-tools";
import type { ToolExecutor } from "@/lib/agent/tools/_shared";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TURNS = 25;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_PAIRS = 20;
const MAX_HISTORY_MSG_LENGTH = 8000; // per history message content
// The write cap, the read-only and finance refusals and "is this a write"
// live in src/lib/agent/tool-gate.ts, derived from the registry's own
// predicates. This route no longer keeps a list of mutating tool names.

// Anthropic-hosted web search tool. Used by the agent to resolve company
// names → websites (e.g. "add pfizer as a gold sponsor"). Anthropic executes
// the search server-side and inlines the results; our loop only handles
// client tool_use blocks, so no extra executor code is needed.
// Billing: $10 per 1,000 searches. `max_uses: 3` caps per-request cost.
// NOTE: the org admin must enable web search in the Claude Console
// (https://console.anthropic.com → Settings → Privacy) or the tool call
// will return { error_code: "unavailable" } at runtime.
const WEB_SEARCH_TOOL: WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
};

const AGENT_TOOLS: ToolUnion[] = [...AGENT_TOOL_DEFINITIONS, WEB_SEARCH_TOOL];

// Per-request client on a SERVER-RESOLVED key (per-tenant AI keys, item 7):
// the org's own Anthropic key when configured, else the env fallback — the
// caller resolves it via resolveAnthropicApiKey(orgId). The Event Agent is
// Anthropic-only this round (its tool loop + the server-side web_search tool
// are Anthropic-specific). NOTE for tenants on their own key: web_search must
// be enabled in THAT org's Anthropic Console, or sponsor-research/web lookups
// degrade to { error_code: "unavailable" } (the agent handles it gracefully).
function getAnthropic(apiKey: string) {
  return new Anthropic({ apiKey });
}

type SSEEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input: unknown; toolUseId: string }
  | { type: "tool_result"; name: string; result: unknown; toolUseId: string }
  | { type: "done" }
  | { type: "error"; message: string };

async function runAgentLoop(
  userMessage: string,
  history: MessageParam[],
  context: AgentContext,
  send: (event: SSEEvent) => void,
  readOnly = false,
  // Separate from readOnly on purpose: read-only ≠ no-finance in general.
  // Today the only agent-eligible role lacking finance is MEMBER (which is
  // also the only read-only one), but keeping these orthogonal means a
  // future role can't accidentally inherit the wrong boundary.
  blockFinance = false
): Promise<void> {
  const systemPrompt = await buildSystemPrompt(
    context.eventId,
    context.organizationId,
    readOnly,
    AGENT_TOOL_DEFINITIONS
  );

  const messages: MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  // Org-resolved key: context.organizationId comes from the route's
  // requireOrgId guard, so the agent bills the org's own Anthropic account
  // when one is configured (env fallback otherwise — master unchanged).
  const anthropic = getAnthropic(await resolveAnthropicApiKey(context.organizationId));
  // Model, output cap and temperature come from the AI config registry
  // (readiness gap G9): AGENT_MODEL in the environment pins a successor
  // model without a deploy, and this route no longer names one.
  const modelConfig = getModelConfig("agent");

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = anthropic.messages.stream({
      model: modelConfig.model,
      max_tokens: modelConfig.maxTokens,
      temperature: modelConfig.temperature,
      system: systemPrompt,
      tools: AGENT_TOOLS,
      messages,
    });

    // Stream text tokens as they arrive
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        send({ type: "text_delta", text: event.delta.text });
      }
    }

    const response = await stream.finalMessage();

    // Append assistant response to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Agent finished naturally
      return;
    }

    if (response.stop_reason !== "tool_use") {
      // Unexpected stop (max_tokens, etc.)
      return;
    }

    // Execute all tool calls
    const toolResults: MessageParam["content"] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const toolName = block.name;
      const toolInput = block.input as Record<string, unknown>;

      send({
        type: "tool_start",
        name: toolName,
        input: toolInput,
        toolUseId: block.id,
      });

      const executor = TOOL_EXECUTOR_MAP[toolName] as ToolExecutor | undefined;
      let result: unknown;
      const toolStart = Date.now();

      // One gate decides the read-only, roster, finance and write-cap
      // refusals (src/lib/agent/tool-gate.ts). The model sees a refusal
      // as a normal tool error and relays it.
      const decision = executor
        ? gateToolCall(toolName, {
            readOnly,
            blockFinance,
            writesSoFar: context.counters.creates,
          })
        : null;
      if (!executor || decision === null) {
        result = { error: `Unknown tool: ${toolName}`, code: "UNKNOWN_TOOL" };
      } else if (decision.kind === "refuse") {
        result = decision.result;
      } else {
        if (decision.write) context.counters.creates++;
        result = await executor(toolInput, context);
        // Mixed tools (list_registrations, list_ticket_types,
        // get_event_stats…) carry money fields alongside operational
        // data — strip the financial keys for non-finance roles but keep
        // the rest (e.g. paymentStatus label survives).
        if (blockFinance) result = redactFinancialFields(result);
      }

      // Mirror the MCP transport's logging convention so the in-app agent path
      // shows up in /logs at the same level (info on success, warn on
      // validation-error returns, error already covered by the executor's own
      // try/catch). Without this, agent runs were silent on validation failures.
      const toolDurationMs = Date.now() - toolStart;
      if (result && typeof result === "object" && "error" in (result as object)) {
        const errObj = result as { error?: unknown; code?: unknown };
        apiLogger.warn({
          msg: "agent tool validation-error",
          tool: toolName,
          eventId: context.eventId,
          organizationId: context.organizationId,
          userId: context.userId,
          source: context.source,
          durationMs: toolDurationMs,
          err: typeof errObj.error === "string" ? errObj.error : JSON.stringify(errObj.error),
          code: typeof errObj.code === "string" ? errObj.code : undefined,
        });
      } else {
        apiLogger.info({
          msg: "agent tool call",
          tool: toolName,
          eventId: context.eventId,
          organizationId: context.organizationId,
          userId: context.userId,
          source: context.source,
          durationMs: toolDurationMs,
        });
      }

      send({
        type: "tool_result",
        name: toolName,
        result,
        toolUseId: block.id,
      });

      if (Array.isArray(toolResults)) {
        // The model receives the result inside a delimited data block and
        // the prompt says what is inside is data, never an instruction
        // (readiness gap G3). The page still gets the raw result above.
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: wrapToolResultAsData(toolName, result),
        });
      }
    }

    // Feed tool results back to model
    messages.push({ role: "user", content: toolResults });
  }

  // Hit max turns
  send({
    type: "error",
    message:
      "The agent reached its maximum number of steps. Please try a simpler request or break it into smaller parts.",
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const [session, { eventId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/agent/execute:POST" });
    if ("error" in orgGuard) return orgGuard.error;

  // Role gate. NOTE: we deliberately do NOT call denyReviewer() here —
  // that guard 403s MEMBER, but MEMBER is allowed to use the agent in
  // READ-ONLY mode (write tools are blocked per-tool below). The explicit
  // allow-list is the single source of truth for who reaches the agent.
  // REVIEWER / SUBMITTER / REGISTRANT are excluded by omission.
  const role = session.user.role;
  if (!["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // MEMBER is the org-bound read-only viewer. It can drive the agent for
  // reporting / lookups but every mutating tool call is refused (fail
  // closed: only list_/get_/search_ prefixed tools are permitted).
  const isReadOnlyMember = role === "MEMBER";
  // Non-finance roles get finance-only tools refused + financial fields
  // redacted from mixed tool results. Derived from the role, not from
  // isReadOnlyMember, so the two boundaries stay independent.
  const blockFinance = !canViewFinance(role);

  // Rate limit: 20 agent requests per user per hour
  const rl = checkRateLimit({
    key: `agent-${session.user.id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return rateLimited(rl, {
      route: "events/agent-execute",
      message: `Rate limit reached. Please wait ${rl.retryAfterSeconds} seconds.`,
      userId: session.user.id,
      limit: 20,
      windowSeconds: 3600,
    });
  }

  let body: { message?: unknown; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = String(body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `message must be under ${MAX_MESSAGE_LENGTH} characters` },
      { status: 400 }
    );
  }

  // Pre-verify event belongs to this org — fail fast before spending Anthropic tokens
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: orgGuard.orgId },
    select: { id: true },
  });
  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  // Validate and cap history
  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history: MessageParam[] = rawHistory
    .filter(
      (m): m is { role: string; content: string } =>
        typeof m === "object" &&
        m !== null &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role as "user" | "assistant",
      // Cap individual message content to prevent context flooding
      content: m.content.slice(0, MAX_HISTORY_MSG_LENGTH),
    }))
    .slice(-MAX_HISTORY_PAIRS * 2);

  const context: AgentContext = {
    eventId,
    organizationId: orgGuard.orgId,
    userId: session.user.id,
    // Audit rows written by this request say the in-app agent did it,
    // not an MCP client (readiness gap G5).
    source: "agent",
    counters: { creates: 0, emailsSent: 0 },
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: SSEEvent) {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // Client disconnected — ignore enqueue errors
        }
      }

      try {
        await runAgentLoop(message, history, context, send, isReadOnlyMember, blockFinance);
        send({ type: "done" });
      } catch (err) {
        apiLogger.error({ err, eventId }, "agent:execute failed");
        // Mask provider-specific details — never leak API internals to client
        const msg =
          err instanceof Anthropic.APIError
            ? `AI provider error (${err.status}). Please try again.`
            : "An unexpected error occurred. Please try again.";
        send({ type: "error", message: msg });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering for SSE (EC2/Docker)
    },
  });
}
