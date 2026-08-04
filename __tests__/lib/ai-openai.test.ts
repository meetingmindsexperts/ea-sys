/**
 * Tests for the OpenAI adapter behind the `AiProvider` abstraction
 * (per-tenant AI keys, item 7). The SDK is mocked — no network calls.
 *
 * Coverage:
 *   - SystemBlock[] joined (in order) into ONE system message; cache flags
 *     ignored (OpenAI caches automatically)
 *   - streamed `choices[0].delta.content` → our `text` events
 *   - the include_usage final chunk → `done.usage` with
 *     prompt/completion/cached-token mapping
 *   - stream without a usage chunk still emits `done` + warn log
 *   - explicit `apiKey` reaches the SDK constructor; env fallback otherwise;
 *     neither → throw
 *   - `max_completion_tokens` + temperature + model pass-through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, constructedWith, mockApiLogger } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  constructedWith: [] as Array<{ apiKey: string }>,
  mockApiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(opts: { apiKey: string }) {
      constructedWith.push(opts);
    }
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));

import { openAiProvider } from "@/lib/ai/openai";
import type { StreamChatOptions, StreamEvent } from "@/lib/ai";

function makeChunks(deltas: string[], usage?: Record<string, unknown>) {
  const chunks: unknown[] = deltas.map((content) => ({
    choices: [{ delta: { content } }],
  }));
  if (usage) chunks.push({ choices: [], usage });
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

async function collect(opts: StreamChatOptions): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of openAiProvider.streamChat(opts)) out.push(e);
  return out;
}

const BASE: StreamChatOptions = {
  model: "gpt-4o",
  system: [
    { text: "GUIDE BULK", cache: true },
    { text: "role tail" },
  ],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1500,
  temperature: 0.3,
};

beforeEach(() => {
  vi.clearAllMocks();
  constructedWith.length = 0;
  process.env.OPENAI_API_KEY = "sk-oai-env";
});

describe("openAiProvider.streamChat", () => {
  it("joins system blocks in order into one system message + passes model/tokens/temperature", async () => {
    mockCreate.mockResolvedValue(makeChunks(["a"], { prompt_tokens: 1, completion_tokens: 1 }));
    await collect(BASE);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o",
        max_completion_tokens: 1500,
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: "GUIDE BULK\n\nrole tail" },
          { role: "user", content: "hi" },
        ],
      }),
    );
  });

  it("streams text deltas then done.usage from the include_usage chunk (cached tokens mapped)", async () => {
    mockCreate.mockResolvedValue(
      makeChunks(["Hel", "lo"], {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
      }),
    );
    const events = await collect(BASE);
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      {
        type: "done",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 },
      },
    ]);
  });

  it("missing cached-token details maps to undefined", async () => {
    mockCreate.mockResolvedValue(makeChunks(["x"], { prompt_tokens: 5, completion_tokens: 1 }));
    const events = await collect(BASE);
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 1, cacheReadTokens: undefined });
  });

  it("stream without a usage chunk still emits done + warn log", async () => {
    mockCreate.mockResolvedValue(makeChunks(["x"]));
    const events = await collect(BASE);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(mockApiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "ai:openai:usage-unavailable" }),
    );
  });

  it("explicit apiKey reaches the SDK constructor (per-org key)", async () => {
    mockCreate.mockResolvedValue(makeChunks(["x"], { prompt_tokens: 1, completion_tokens: 1 }));
    await collect({ ...BASE, apiKey: "sk-oai-org" });
    expect(constructedWith).toEqual([{ apiKey: "sk-oai-org" }]);
  });

  it("no apiKey → env key; neither → throws", async () => {
    // Unique key so this case misses the module-level client cache (which
    // deliberately persists — the cache key IS the credential).
    process.env.OPENAI_API_KEY = "sk-oai-env-fresh";
    mockCreate.mockResolvedValue(makeChunks(["x"], { prompt_tokens: 1, completion_tokens: 1 }));
    await collect(BASE);
    expect(constructedWith).toEqual([{ apiKey: "sk-oai-env-fresh" }]);

    delete process.env.OPENAI_API_KEY;
    await expect(collect({ ...BASE, model: "gpt-4o-b" })).rejects.toThrow(
      "OPENAI_API_KEY is not set — cannot use the OpenAI AI provider.",
    );
  });
});
