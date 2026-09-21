/**
 * The Event Agent loop with a scripted model: one registration serves the
 * door, the gate decides what runs, and a result reaches the model inside
 * a data block. This is the review's proof for Phase 1, "creating an event
 * through the in-app door", without a network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Message, MessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";

vi.mock("@/lib/db", () => ({
  db: {
    organization: { findUnique: vi.fn(async () => ({ name: "MM Group" })) },
    event: { findFirst: vi.fn(async () => null) },
  },
  dbOperator: {},
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/ai/credentials", () => ({ resolveAnthropicApiKey: vi.fn(async () => "key") }));

import { runAgentRequest, MAX_TURNS, type AgentSseEvent, type ModelStream, type ModelStreamParams } from "@/lib/agent/run-agent";
import { MAX_WRITES_PER_REQUEST } from "@/lib/agent/tool-gate";
import type { RegisteredTool } from "@/lib/agent/tool-registry";

type Block = Message["content"][number];

function scripted(responses: Array<{ blocks: Block[]; stop: "tool_use" | "end_turn"; text?: string }>) {
  const calls: ModelStreamParams[] = [];
  let i = 0;
  const createStream = (params: ModelStreamParams): ModelStream => {
    // The loop mutates one messages array; snapshot what the model saw on this turn.
    calls.push({ ...params, messages: [...params.messages] });
    const r = responses[Math.min(i++, responses.length - 1)];
    const events: MessageStreamEvent[] = r.text
      ? [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text } } as MessageStreamEvent]
      : [];
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      finalMessage: async () =>
        ({ id: "m", type: "message", role: "assistant", model: "x", content: r.blocks, stop_reason: r.stop } as unknown as Message),
    };
  };
  return { createStream, calls };
}

const toolUse = (name: string, input: Record<string, unknown>, id = `t_${name}`): Block =>
  ({ type: "tool_use", id, name, input } as Block);

function fakeTool(name: string, result: unknown): RegisteredTool & { run: ReturnType<typeof vi.fn> } {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    run: vi.fn(async () => ({ text: JSON.stringify(result), isError: false })),
  };
}

function baseReq(over: Partial<Parameters<typeof runAgentRequest>[0]> = {}) {
  const events: AgentSseEvent[] = [];
  return {
    events,
    req: {
      organizationId: "org1",
      eventId: null,
      actor: { userId: "u1", role: "ADMIN", fromApiKey: false },
      message: "create the summit",
      history: [],
      readOnly: false,
      blockFinance: false,
      send: (e: AgentSseEvent) => events.push(e),
      ...over,
    },
  };
}

describe("runAgentRequest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an event through the in-app door and feeds the result back as data", async () => {
    const createEvent = fakeTool("create_event", { success: true, event: { id: "e1", name: "Summit" } });
    const listEvents = fakeTool("list_events", []);
    const { createStream, calls } = scripted([
      { blocks: [toolUse("create_event", { name: "Summit" })], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Done." } as Block], stop: "end_turn", text: "Done." },
    ]);
    const { req, events } = baseReq();
    await runAgentRequest(req, { createStream, tools: [listEvents, createEvent] });

    expect(createEvent.run).toHaveBeenCalledWith({ name: "Summit" });
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "text_delta"]);
    const result = events[1] as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(result.result).toEqual({ success: true, event: { id: "e1", name: "Summit" } });

    // What the model got back: the data block, on the second turn.
    expect(calls).toHaveLength(2);
    const secondTurn = calls[1].messages;
    const toolResultMsg = secondTurn[secondTurn.length - 1];
    const block = (toolResultMsg.content as Array<{ type: string; content?: string; is_error?: boolean }>)[0];
    expect(block.type).toBe("tool_result");
    expect(block.content).toMatch(/^\[BEGIN TOOL DATA: create_event\]\n/);
    expect(block.content).toMatch(/\[END TOOL DATA\]$/);
    expect(block.is_error).toBeUndefined();

    // Prompt and tools are cache candidates; web search rides along.
    const system = calls[0].system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(system[0].text).toContain("## No event selected");
    expect(system[0].text).toContain("MM Group");
    const tools = calls[0].tools as Array<{ name: string; cache_control?: unknown; type?: string }>;
    expect(tools.map((t) => t.name)).toEqual(["list_events", "create_event", "web_search"]);
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(tools[2].type).toBe("web_search_20250305");
  });

  it("refuses a write for a read-only actor without running it", async () => {
    const createEvent = fakeTool("create_event", { success: true });
    const { createStream, calls } = scripted([
      { blocks: [toolUse("create_event", { name: "X" })], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const { req, events } = baseReq({ readOnly: true, actor: { userId: "m1", role: "MEMBER", fromApiKey: false } });
    await runAgentRequest(req, { createStream, tools: [createEvent] });
    expect(createEvent.run).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === "tool_result") as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(result.result).toMatchObject({ code: "READ_ONLY_ROLE" });
    const block = (calls[1].messages.at(-1)!.content as Array<{ is_error?: boolean }>)[0];
    expect(block.is_error).toBe(true);
    expect((calls[0].system as Array<{ text: string }>)[0].text).toContain("READ-ONLY SESSION");
  });

  it("caps writes at the request limit whichever write tool is called", async () => {
    const createTrack = fakeTool("create_track", { success: true });
    const blocks = Array.from({ length: MAX_WRITES_PER_REQUEST + 1 }, (_, i) =>
      toolUse("create_track", { eventId: "ev1", name: `T${i}` }, `t${i}`),
    );
    const { createStream } = scripted([{ blocks, stop: "tool_use" }, { blocks: [], stop: "end_turn" }]);
    const { req, events } = baseReq();
    await runAgentRequest(req, { createStream, tools: [createTrack] });
    expect(createTrack.run).toHaveBeenCalledTimes(MAX_WRITES_PER_REQUEST);
    const results = events.filter((e) => e.type === "tool_result") as Array<Extract<AgentSseEvent, { type: "tool_result" }>>;
    expect(results).toHaveLength(MAX_WRITES_PER_REQUEST + 1);
    expect(results.at(-1)!.result).toMatchObject({ code: "WRITE_LIMIT" });
  });

  it("redacts money from a JSON result for a role without finance sight", async () => {
    const list = fakeTool("list_registrations", { registrations: [{ id: "r1", financials: { total: 100 }, status: "PAID" }] });
    const { createStream, calls } = scripted([
      { blocks: [toolUse("list_registrations", { eventId: "ev1" })], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const { req, events } = baseReq({ blockFinance: true });
    await runAgentRequest(req, { createStream, tools: [list] });
    const result = events.find((e) => e.type === "tool_result") as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(JSON.stringify(result.result)).not.toContain("financials");
    expect(JSON.stringify(result.result)).toContain("PAID");
    const block = (calls[1].messages.at(-1)!.content as Array<{ content: string }>)[0];
    expect(block.content).not.toContain("financials");
  });

  it("answers an unknown tool with an error result instead of throwing", async () => {
    const { createStream } = scripted([
      { blocks: [toolUse("frobnicate", {})], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const { req, events } = baseReq();
    await runAgentRequest(req, { createStream, tools: [] });
    const result = events.find((e) => e.type === "tool_result") as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(result.result).toMatchObject({ code: "UNKNOWN_TOOL" });
  });

  it("stops with an error event after the turn limit", async () => {
    const t = fakeTool("list_events", []);
    const { createStream, calls } = scripted([{ blocks: [toolUse("list_events", {})], stop: "tool_use" }]);
    const { req, events } = baseReq();
    await runAgentRequest(req, { createStream, tools: [t] });
    expect(calls).toHaveLength(MAX_TURNS);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});
