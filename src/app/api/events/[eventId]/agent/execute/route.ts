import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ToolUnion, WebSearchTool20250305 } from "@anthropic-ai/sdk/resources/messages";
import { auth } from "@/lib/auth";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { apiLogger } from "@/lib/logger";
import { db } from "@/lib/db";
import { AGENT_TOOL_DEFINITIONS, TOOL_EXECUTOR_MAP } from "@/lib/agent/event-tools";
import { buildSystemPrompt } from "@/lib/agent/system-prompt";
import type { AgentContext } from "@/lib/agent/event-tools";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TURNS = 25;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_PAIRS = 20;
const MAX_HISTORY_MSG_LENGTH = 8000; // per history message content
const MAX_CREATES_PER_REQUEST = 20;

const MUTATING_TOOLS = new Set([
  "create_track", "create_speaker", "create_session", "create_ticket_type",
  "create_registration", "create_abstract_theme", "create_review_criterion",
  "create_hotel", "create_contact", "add_topic_to_session",
  "update_abstract_status", "check_in_registration", "send_bulk_email",
  "upsert_sponsors",
]);

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

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
  send: (event: SSEEvent) => void
): Promise<void> {
  const systemPrompt = await buildSystemPrompt(
    context.eventId,
    context.organizationId
  );

  const messages: MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const anthropic = getAnthropic();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
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

      const executor = TOOL_EXECUTOR_MAP[toolName];
      let result: unknown;
      const toolStart = Date.now();

      if (!executor) {
        result = { error: `Unknown tool: ${toolName}` };
      } else if (MUTATING_TOOLS.has(toolName) && context.counters.creates >= MAX_CREATES_PER_REQUEST) {
        result = { error: `Resource modification limit reached for this request (max ${MAX_CREATES_PER_REQUEST}). Please send a new message to continue.` };
      } else {
        if (MUTATING_TOOLS.has(toolName)) context.counters.creates++;
        result = await executor(toolInput, context);
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
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
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

  const denied = denyReviewer(session);
  if (denied) return denied;

  // Only ADMIN/ORGANIZER roles can use the agent
  const role = session.user.role;
  if (!["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER"].includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Rate limit: 20 agent requests per user per hour
  const rl = checkRateLimit({
    key: `agent-${session.user.id}`,
    limit: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit reached. Please wait ${rl.retryAfterSeconds} seconds.`,
      },
      { status: 429 }
    );
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
    where: { id: eventId, organizationId: session.user.organizationId! },
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
    organizationId: session.user.organizationId!,
    userId: session.user.id,
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
        await runAgentLoop(message, history, context, send);
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
