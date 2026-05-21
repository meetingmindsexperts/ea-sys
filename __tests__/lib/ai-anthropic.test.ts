/**
 * Tests for the Anthropic adapter behind the `AiProvider` abstraction.
 *
 * These pin the translation layer between our normalized
 * `StreamChatOptions` / `StreamEvent` shape and the Anthropic SDK's
 * specifics — the layer that future provider swaps depend on. The SDK
 * itself is mocked; we don't make network calls.
 *
 * Coverage:
 *   - `SystemBlock.cache: true` → `cache_control: { type: "ephemeral" }`
 *   - `SystemBlock.cache: false | undefined` → no `cache_control`
 *   - SDK `content_block_delta` text_deltas → our `text` events
 *   - Non-text deltas ignored
 *   - SDK `finalMessage().usage` → our `done.usage` (with null → undefined
 *     mapping for cache_read / cache_creation fields)
 *   - Mid-stream `finalMessage()` failure still emits `done` without usage
 *   - Missing `ANTHROPIC_API_KEY` throws on first use
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock — must be top-level so it's installed before the
// adapter module is imported and reads the SDK constructor.
const mockMessagesStream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { stream: mockMessagesStream };
      // No-op constructor — we just need a constructible class
      // exposing `.messages.stream`. The `apiKey` option is ignored.
    },
  };
});

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { anthropicProvider } from "@/lib/ai/anthropic";
import type { StreamChatOptions, StreamEvent } from "@/lib/ai";

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  mockMessagesStream.mockReset();
});

/**
 * Build a fake Anthropic stream that's both async-iterable AND has
 * `finalMessage()` — mirroring the SDK's `MessageStream` shape. Text
 * deltas are emitted in order; the supplied `usage` is returned by
 * `finalMessage()` (or thrown if `finalMessageError` is set).
 */
function makeMockStream(opts: {
  textDeltas: string[];
  /** Any extra non-text events to mix in (verifies they're filtered). */
  extraEvents?: unknown[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  finalMessageError?: Error;
}) {
  const textEvents = opts.textDeltas.map((text) => ({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  }));
  const events = [...(opts.extraEvents ?? []), ...textEvents];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
    finalMessage: opts.finalMessageError
      ? vi.fn().mockRejectedValue(opts.finalMessageError)
      : vi
          .fn()
          .mockResolvedValue({ usage: opts.usage ?? { input_tokens: 0, output_tokens: 0 } }),
  };
}

const BASE_OPTS: StreamChatOptions = {
  model: "claude-sonnet-4-6",
  system: [],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
};

async function drain(opts: StreamChatOptions): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of anthropicProvider.streamChat(opts)) events.push(e);
  return events;
}

describe("anthropicProvider — system block mapping", () => {
  it("attaches cache_control: ephemeral when SystemBlock.cache is true", async () => {
    mockMessagesStream.mockReturnValue(makeMockStream({ textDeltas: [] }));
    await drain({
      ...BASE_OPTS,
      system: [{ text: "GUIDE CONTENT", cache: true }],
    });
    const args = mockMessagesStream.mock.calls[0][0];
    expect(args.system).toEqual([
      { type: "text", text: "GUIDE CONTENT", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("omits cache_control when SystemBlock.cache is false or absent", async () => {
    mockMessagesStream.mockReturnValue(makeMockStream({ textDeltas: [] }));
    await drain({
      ...BASE_OPTS,
      system: [{ text: "uncached" }, { text: "also uncached", cache: false }],
    });
    const args = mockMessagesStream.mock.calls[0][0];
    expect(args.system).toEqual([
      { type: "text", text: "uncached" },
      { type: "text", text: "also uncached" },
    ]);
  });

  it("preserves block order so cached prefix is contiguous", async () => {
    // Real production usage: cached guide first, uncached role tail
    // second. The cache only matches a contiguous prefix.
    mockMessagesStream.mockReturnValue(makeMockStream({ textDeltas: [] }));
    await drain({
      ...BASE_OPTS,
      system: [
        { text: "stable guide", cache: true },
        { text: "per-request role tail" },
      ],
    });
    const args = mockMessagesStream.mock.calls[0][0];
    expect(args.system[0].text).toBe("stable guide");
    expect(args.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(args.system[1].text).toBe("per-request role tail");
    expect(args.system[1].cache_control).toBeUndefined();
  });
});

describe("anthropicProvider — request shape", () => {
  it("passes model, max_tokens, temperature, and messages through to the SDK", async () => {
    mockMessagesStream.mockReturnValue(makeMockStream({ textDeltas: [] }));
    await drain({
      model: "claude-sonnet-4-6",
      system: [],
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how do I add a registration?" },
      ],
      maxTokens: 1500,
      temperature: 0.3,
    });
    const args = mockMessagesStream.mock.calls[0][0];
    expect(args.model).toBe("claude-sonnet-4-6");
    expect(args.max_tokens).toBe(1500);
    expect(args.temperature).toBe(0.3);
    expect(args.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how do I add a registration?" },
    ]);
  });

  it("omits temperature entirely when not supplied (lets provider default apply)", async () => {
    mockMessagesStream.mockReturnValue(makeMockStream({ textDeltas: [] }));
    await drain(BASE_OPTS);
    const args = mockMessagesStream.mock.calls[0][0];
    expect(args).not.toHaveProperty("temperature");
  });
});

describe("anthropicProvider — stream events", () => {
  it("yields a text event for each content_block_delta with a text_delta", async () => {
    mockMessagesStream.mockReturnValue(
      makeMockStream({ textDeltas: ["To ", "add ", "a registration..."] }),
    );
    const events = await drain(BASE_OPTS);
    // First three should be text deltas in order; last is done.
    expect(events.slice(0, 3)).toEqual([
      { type: "text", delta: "To " },
      { type: "text", delta: "add " },
      { type: "text", delta: "a registration..." },
    ]);
    expect(events[events.length - 1].type).toBe("done");
  });

  it("ignores non-text events (message_start, content_block_start, message_delta, etc.)", async () => {
    mockMessagesStream.mockReturnValue(
      makeMockStream({
        textDeltas: ["hello"],
        extraEvents: [
          { type: "message_start" },
          { type: "content_block_start" },
          { type: "content_block_delta", delta: { type: "input_json_delta" } },
          { type: "message_delta" },
        ],
      }),
    );
    const events = await drain(BASE_OPTS);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toEqual([{ type: "text", delta: "hello" }]);
  });

  it("emits a final done event carrying usage stats from finalMessage()", async () => {
    mockMessagesStream.mockReturnValue(
      makeMockStream({
        textDeltas: ["hi"],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 30000,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    const events = await drain(BASE_OPTS);
    expect(events[events.length - 1]).toEqual({
      type: "done",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 30000,
        cacheWriteTokens: 0,
      },
    });
  });

  it("maps null cache_read_input_tokens / cache_creation_input_tokens to undefined", async () => {
    mockMessagesStream.mockReturnValue(
      makeMockStream({
        textDeltas: [],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );
    const events = await drain(BASE_OPTS);
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    if (done.type === "done") {
      expect(done.usage?.cacheReadTokens).toBeUndefined();
      expect(done.usage?.cacheWriteTokens).toBeUndefined();
    }
  });

  it("still emits a done event when finalMessage() throws — no usage but loop ends cleanly", async () => {
    mockMessagesStream.mockReturnValue(
      makeMockStream({
        textDeltas: ["partial"],
        finalMessageError: new Error("stream interrupted"),
      }),
    );
    const events = await drain(BASE_OPTS);
    expect(events).toContainEqual({ type: "text", delta: "partial" });
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    if (done.type === "done") expect(done.usage).toBeUndefined();
  });
});

describe("anthropicProvider — configuration", () => {
  it("throws on first use when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    // Iterate to trigger the lazy client(). The async-generator throws
    // on the first `next()`, so we use a wrapping function to assert.
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of anthropicProvider.streamChat(BASE_OPTS)) {
        // unreachable — the iterator throws before yielding
      }
    }).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});
