/**
 * Anthropic implementation of `AiProvider`. Wraps `@anthropic-ai/sdk`'s
 * `messages.stream()` and translates SDK events to our normalized
 * `StreamEvent` shape so callers can stay provider-agnostic.
 *
 * Cache control: a `SystemBlock` with `cache: true` is mapped to
 * `cache_control: { type: "ephemeral" }`. The Anthropic prompt cache has
 * a 5-minute TTL; first-after-idle calls pay a cache-write tax, all
 * subsequent calls in the window pay the much cheaper cache-read price.
 * For whole-document patterns (the help chatbot's user guide), this is
 * the load-bearing cost optimization — without it the design's cost
 * model doesn't work.
 */

import Anthropic from "@anthropic-ai/sdk";
import { apiLogger } from "@/lib/logger";
import type { AiProvider, StreamChatOptions, StreamEvent } from "./index";

// Client cache keyed by API key — most processes only see one key in
// their lifetime, but keying on the key means env changes between calls
// (rare; mostly in tests) rebuild the client instead of returning stale
// state. Construction is cheap (no network), so this is a small win for
// HTTP-agent reuse, not a hot-path optimization.
let _client: Anthropic | null = null;
let _clientKey: string | undefined;

function client(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set — cannot use the Anthropic AI provider.",
    );
  }
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey });
    _clientKey = apiKey;
  }
  return _client;
}

export const anthropicProvider: AiProvider = {
  async *streamChat(opts: StreamChatOptions): AsyncIterable<StreamEvent> {
    // `SystemBlock[]` → Anthropic's `system` parameter shape. Each entry
    // becomes a `text` content block; `cache: true` attaches the
    // ephemeral cache control flag so the block participates in prompt
    // caching. Order matters — Anthropic caches the longest matching
    // prefix, so put stable bulk content (e.g. the user guide) first
    // and per-request tail (e.g. the user's role) last.
    const system = opts.system.map((block) => ({
      type: "text" as const,
      text: block.text,
      ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const stream = client().messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      system,
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    // Forward text deltas as they arrive. We deliberately ignore non-
    // text events here (content_block_start/stop, message_start/delta/
    // stop, etc.) — the consumer of `StreamEvent` only cares about
    // tokens-as-they-arrive plus the final usage tally below.
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text", delta: event.delta.text };
      }
    }

    // After the stream closes, pull the assembled message for the final
    // usage stats (input/output + cache read/write tokens). The two
    // cache fields are nullable in the SDK; we map `null` → `undefined`
    // so consumers can treat "absent" uniformly.
    try {
      const finalMsg = await stream.finalMessage();
      yield {
        type: "done",
        usage: {
          inputTokens: finalMsg.usage.input_tokens,
          outputTokens: finalMsg.usage.output_tokens,
          cacheReadTokens: finalMsg.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens:
            finalMsg.usage.cache_creation_input_tokens ?? undefined,
        },
      };
    } catch (err) {
      // Stream closed without a final message (rare — usually a
      // mid-stream SDK error). Still emit `done` so the caller's loop
      // ends cleanly; usage is missing. Logged as `warn` (not error)
      // because the per-failure-must-log rule applies but this is
      // recoverable from the caller's perspective.
      apiLogger.warn({ msg: "ai:anthropic:final-message-unavailable", err });
      yield { type: "done" };
    }
  },
};
