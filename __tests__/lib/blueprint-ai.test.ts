/** runBlueprintAiTask: refusals before any AI call, the answer parsed as JSON, provider failures logged. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, mockLogger } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mockCreate }; } }));
vi.mock("@/lib/ai/credentials", () => ({ resolveAnthropicApiKey: vi.fn().mockResolvedValue("sk-test") }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));

import { parseJsonAnswer, runBlueprintAiTask } from "@/lib/blueprint/blueprint-ai";

const base = { organizationId: "org-1", userId: "u-1" };
const reply = (text: string) => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]).toString("base64");

beforeEach(() => vi.clearAllMocks());

describe("runBlueprintAiTask", () => {
  it("refuses an unknown task without calling the AI", async () => {
    expect(await runBlueprintAiTask({ ...base, task: "write-me-an-essay", input: {} })).toMatchObject({ ok: false, code: "UNKNOWN_TASK" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a raw prompt smuggled as input (a task needs its own fields)", async () => {
    expect(await runBlueprintAiTask({ ...base, task: "spaces", input: { prompt: "anything" } })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a picture that is not an image, and pictures on any task but quick fill are dropped", async () => {
    const notImage = Buffer.from("%PDF-1.7").toString("base64");
    expect(await runBlueprintAiTask({ ...base, task: "quickfill", input: { words: "x" }, images: [{ data: notImage }] })).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
    mockCreate.mockResolvedValue(reply('{"spaces":[]}'));
    await runBlueprintAiTask({ ...base, task: "spaces", input: { brief: {} }, images: [{ data: png }] });
    expect(mockCreate.mock.calls[0][0].messages[0].content).toHaveLength(1);
  });

  it("sends the server's prompt and the picture, on the default tier, and returns the JSON", async () => {
    mockCreate.mockResolvedValue(reply('Here you go:\n```json\n{"type":"gala"}\n```'));
    const res = await runBlueprintAiTask({ ...base, task: "quickfill", input: { words: "a gala" }, images: [{ data: png }] });
    expect(res).toEqual({ ok: true, answer: { type: "gala" } });
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(call.messages[0].content[1].text).toContain("You are filling in an event planning form");
    expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "blueprint-ai:answered", inputTokens: 10 }));
  });

  it("uses the quick tier for a suggestion", async () => {
    mockCreate.mockResolvedValue(reply('{"segments":[]}'));
    await runBlueprintAiTask({ ...base, task: "segments", input: { brief: {} } });
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("an answer with no JSON is INVALID_JSON", async () => {
    mockCreate.mockResolvedValue(reply("Sorry, I can't help with that."));
    expect(await runBlueprintAiTask({ ...base, task: "segments", input: { brief: {} } })).toMatchObject({ ok: false, code: "INVALID_JSON" });
  });

  it("a provider failure is AI_UNAVAILABLE, logged at error", async () => {
    mockCreate.mockRejectedValue(new Error("overloaded"));
    expect(await runBlueprintAiTask({ ...base, task: "segments", input: { brief: {} } })).toMatchObject({ ok: false, code: "AI_UNAVAILABLE" });
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "blueprint-ai:provider-failed" }));
  });
});

describe("parseJsonAnswer", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ["text {\"a\":1} text", { a: 1 }],
    ["[1,2]", null],
    ["{broken", null],
  ])("%s", (text, expected) => {
    expect(parseJsonAnswer(text)).toEqual(expected);
  });
});
