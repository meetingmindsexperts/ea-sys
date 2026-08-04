/**
 * OpenAI implementation of `AiProvider` (per-tenant AI keys, item 7 phase 3).
 * Wraps `openai`'s `chat.completions.create({ stream: true })` and translates
 * chunks to the normalized `StreamEvent` shape.
 *
 * Cache flags on `SystemBlock` are IGNORED here by design — OpenAI prompt
 * caching is automatic (no per-block opt-in like Anthropic's
 * `cache_control`); the blocks are joined into one system message in order,
 * which preserves the stable-bulk-first layout the cache benefits from.
 */

import OpenAI from "openai";
import { apiLogger } from "@/lib/logger";
import type { AiProvider, StreamChatOptions, StreamEvent } from "./index";

// Bounded client cache keyed by the API key string. The cache key IS the
// credential, so a changed org key naturally misses — no invalidation hook
// needed (unlike the Stripe orgId-keyed cache). Construction is cheap; this
// only buys HTTP-agent reuse.
const clients = new Map<string, OpenAI>();
const MAX_CLIENTS = 20;

function client(apiKey?: string): OpenAI {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot use the OpenAI AI provider.",
    );
  }
  const cached = clients.get(key);
  if (cached) return cached;
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  const created = new OpenAI({ apiKey: key });
  clients.set(key, created);
  return created;
}

export const openAiProvider: AiProvider = {
  async *streamChat(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    // SystemBlock[] → one system message, blocks joined in order.
    const systemText = opts.system.map((b) => b.text).join("\n\n");

    const stream = await client(opts.apiKey).chat.completions.create({
      model: opts.model,
      // `max_completion_tokens` is the current parameter (works across
      // gpt-4o and the reasoning models; `max_tokens` is deprecated).
      max_completion_tokens: opts.maxTokens,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      messages: [
        { role: "system" as const, content: systemText },
        ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
      // Emits a final chunk carrying token usage (choices: []).
      stream_options: { include_usage: true },
    });

    let usage: StreamEvent | null = null;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        yield { type: "text", delta };
      }
      if (chunk.usage) {
        usage = {
          type: "done",
          usage: {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            // OpenAI's automatic prompt cache reports read hits here;
            // there is no write-side accounting (maps to undefined).
            cacheReadTokens:
              chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
          },
        };
      }
    }

    if (usage) {
      yield usage;
    } else {
      // Stream closed without a usage chunk (rare). Still emit `done` so
      // the caller's loop ends cleanly; usage is missing.
      apiLogger.warn({ msg: "ai:openai:usage-unavailable" });
      yield { type: "done" };
    }
  },
};
