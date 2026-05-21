/**
 * `AiProvider` — provider-agnostic interface for streaming chat
 * completions. Lets the codebase depend on a small surface instead of a
 * specific SDK, so future vendor swaps (or per-feature provider choice,
 * or reliability fallbacks) become config-flips instead of rewrites.
 *
 * **v1 scope**: streaming chat only. No tool use here (the existing AI
 * Agent's tool surface is large and provider-specific; we keep that
 * route on the raw SDK until we have a second provider to motivate
 * abstracting tools too). No vision / non-streaming / audio / batch.
 *
 * Today's only implementation: `anthropic.ts`. Future adapters
 * (`openai.ts`, `ollama.ts`, …) plug into the same shape.
 */

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

export interface SystemBlock {
  text: string;
  /**
   * Hint to the provider that this block should participate in prompt
   * caching. Providers that don't support caching ignore the flag.
   * Anthropic translates `cache: true` to
   * `cache_control: { type: "ephemeral" }` (5-min TTL on a hit), which
   * is the load-bearing optimization for whole-document-in-prompt
   * patterns (e.g. the help chatbot's user-guide system prompt).
   */
  cache?: boolean;
}

export interface StreamChatOptions {
  /** Provider-specific model id, e.g. `"claude-sonnet-4-6"`. */
  model: string;
  /** System blocks in order. First blocks are good cache candidates. */
  system: SystemBlock[];
  /** Conversation history; the last entry should be the user turn. */
  messages: Message[];
  /** Hard cap on the response output tokens. */
  maxTokens: number;
  /** Optional sampling temperature (provider default if omitted). */
  temperature?: number;
}

/**
 * Per-request usage stats from the provider. All token counts are
 * post-stream — the provider tallies them after the message ends.
 * `cacheReadTokens` / `cacheWriteTokens` are Anthropic-specific and
 * undefined on providers that don't expose cache accounting.
 */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Events yielded by `streamChat`. Callers should treat the stream as
 * "zero or more `text` events, followed by exactly one `done`."
 *
 * Network / API errors are THROWN (not yielded) so callers can use a
 * single try/catch around the for-await loop. Mid-stream interruptions
 * also throw — the loop ends with an exception.
 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "done"; usage?: UsageStats };

export interface AiProvider {
  streamChat(opts: StreamChatOptions): AsyncIterable<StreamEvent>;
}

// ── Default provider resolution ──────────────────────────────────────
//
// One call site (`getDefaultAiProvider()`) returns the configured
// provider. Today it's always Anthropic; later we can add an env-var
// switch or per-feature override here without touching consumers.
//
// Import is at module bottom to avoid an early circular-import edge
// case if the Anthropic adapter ever pulls types from this file.

import { anthropicProvider } from "./anthropic";

export function getDefaultAiProvider(): AiProvider {
  return anthropicProvider;
}
