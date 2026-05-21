/**
 * Help-chat API route.
 *
 *   POST /api/help-chat
 *     body: { messages: Array<{role: "user" | "assistant", content: string}> }
 *     auth: session required (any authenticated role)
 *     rate: 50 messages / hour / user
 *     response: SSE stream of
 *       data: {"type":"text","delta":"..."}     (zero or more)
 *       data: {"type":"done","usage":{...}}     (exactly one)
 *     errors:
 *       401  no session
 *       400  invalid body (Zod fail) or last message not user
 *       429  rate limit exceeded (carries Retry-After + retryAfterSeconds)
 *       500  unhandled — also surfaced as in-stream {"type":"error"} when
 *            the failure happens mid-stream
 *
 * Stateless: the client owns conversation history; each request sends
 * the full `messages` array. No DB writes from this route (the audit
 * log is intentionally NOT used — we don't want to persist user
 * questions, even metadata-only entries that hint at them, beyond what
 * Pino's `info` log records).
 *
 * Logging: metadata only — userId, role, message count, input char
 * count, completion timing, token usage. Message bodies are NEVER
 * logged (privacy — users may ask questions referencing real attendee
 * data).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { getDefaultAiProvider } from "@/lib/ai";
import { getModelConfig } from "@/lib/ai/config";
import { buildSystemPrompt } from "@/lib/help-chat/system-prompt";

const HELP_CHAT_RATE_LIMIT = 50;
const HELP_CHAT_RATE_WINDOW_MS = 60 * 60 * 1000;

// Per the plan: server-side caps. Client also enforces a soft cap
// around 20 turns with a "start fresh" banner; the server cap is the
// hard upper bound.
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 4000;

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(MAX_CHARS_PER_MESSAGE),
});

const RequestBodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES),
});

export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // ── 1. Auth ──────────────────────────────────────────────────────
  const session = await auth();
  if (!session?.user) {
    apiLogger.warn({ msg: "help-chat:unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const role = session.user.role ?? null;

  // ── 2. Rate limit ────────────────────────────────────────────────
  // Per-user bucket; separate from MCP / agent so they don't compete.
  const rl = checkRateLimit({
    key: `help-chat:${userId}`,
    limit: HELP_CHAT_RATE_LIMIT,
    windowMs: HELP_CHAT_RATE_WINDOW_MS,
  });
  if (!rl.allowed) {
    apiLogger.warn({
      msg: "help-chat:rate-limited",
      userId,
      retryAfterSeconds: rl.retryAfterSeconds,
    });
    return NextResponse.json(
      {
        error: "Too many messages. Please try again later.",
        retryAfterSeconds: rl.retryAfterSeconds,
        limit: HELP_CHAT_RATE_LIMIT,
        windowSeconds: HELP_CHAT_RATE_WINDOW_MS / 1000,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSeconds) },
      },
    );
  }

  // ── 3. Validate body ─────────────────────────────────────────────
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    apiLogger.warn({ msg: "help-chat:invalid-json", userId });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = RequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    apiLogger.warn({
      msg: "help-chat:zod-validation-failed",
      userId,
      errors: parsed.error.flatten(),
    });
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { messages } = parsed.data;

  // Last message must be a user turn — the bot answers TO a user, not
  // assistant-continues itself. Catches misuse + client bugs.
  if (messages[messages.length - 1].role !== "user") {
    apiLogger.warn({
      msg: "help-chat:last-message-not-user",
      userId,
      lastRole: messages[messages.length - 1].role,
    });
    return NextResponse.json(
      { error: "The last message must be a user turn." },
      { status: 400 },
    );
  }

  // ── 4. Build role-aware system prompt ────────────────────────────
  // REVIEWER / SUBMITTER / REGISTRANT have organizationId: null per the
  // RBAC architecture — they're org-independent. For those we skip the
  // DB lookup and let the role tail fall back to "their organization".
  let organizationName: string | null = null;
  if (session.user.organizationId) {
    try {
      const org = await db.organization.findUnique({
        where: { id: session.user.organizationId },
        select: { name: true },
      });
      organizationName = org?.name ?? null;
    } catch (err) {
      // Org name is non-critical — log + continue with the fallback.
      apiLogger.warn({ msg: "help-chat:org-lookup-failed", userId, err });
    }
  }

  const inputCharCount = messages.reduce((n, m) => n + m.content.length, 0);
  apiLogger.info({
    msg: "help-chat:request",
    userId,
    role,
    organizationId: session.user.organizationId,
    messageCount: messages.length,
    inputCharCount,
  });

  const config = getModelConfig("helpChat");
  const system = buildSystemPrompt({
    role,
    organizationName,
    firstName: session.user.firstName ?? null,
  });
  const provider = getDefaultAiProvider();

  // ── 5. SSE stream ────────────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        for await (const event of provider.streamChat({
          model: config.model,
          system,
          messages,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
        })) {
          send(event);
          if (event.type === "done") {
            apiLogger.info({
              msg: "help-chat:complete",
              userId,
              inputTokens: event.usage?.inputTokens,
              outputTokens: event.usage?.outputTokens,
              cacheReadTokens: event.usage?.cacheReadTokens,
              cacheWriteTokens: event.usage?.cacheWriteTokens,
              latencyMs: Date.now() - startedAt,
            });
          }
        }
      } catch (err) {
        // Mid-stream failure — surface as an in-stream error event so
        // the client can render "having trouble, please retry" without
        // leaving a half-written assistant message in the UI.
        apiLogger.error({
          msg: "help-chat:provider-error",
          userId,
          model: config.model,
          err,
        });
        send({
          type: "error",
          message:
            "Help chat is unavailable right now. Please try again in a moment.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      // Critical on EC2 — nginx buffers response bodies by default,
      // which would swallow the SSE stream and deliver it all-at-once
      // after the model finishes (defeats the point of streaming).
      "X-Accel-Buffering": "no",
    },
  });
}
