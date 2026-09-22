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

function scripted(responses: Array<{ blocks: Block[]; stop: "tool_use" | "end_turn" | "max_tokens"; text?: string }>) {
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

  it("ends as output_limit with an error event when the reply is cut at max_tokens, running no tool", async () => {
    // Golden W9 (September 22, 2026): three HTML bodies in one turn overran
    // the cap; the loop used to answer "completed" with nothing done.
    const t = fakeTool("create_email_template", { success: true });
    const { createStream, calls } = scripted([
      { blocks: [{ type: "text", text: "I'll now create all three." } as Block, toolUse("create_email_template", { name: "a" })], stop: "max_tokens" },
    ]);
    const { req, events } = baseReq();
    const ended = await runAgentRequest(req, { createStream, tools: [t] });
    expect(ended).toBe("output_limit");
    expect(calls).toHaveLength(1);
    expect(t.run).not.toHaveBeenCalled();
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { message: string }).message)).toMatch(/output limit/);
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

describe("runAgentRequest approvals", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET ??= "test-secret-for-approval-tokens";
  });

  it("pauses an approval-required tool: the page gets a token, the model gets APPROVAL_REQUIRED, nothing runs", async () => {
    const send = fakeTool("send_bulk_email", { sent: 200 });
    const { createStream, calls } = scripted([
      { blocks: [toolUse("send_bulk_email", { eventId: "ev1", recipientType: "speakers", subject: "Hi", message: "<p>x</p>", confirm: true })], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const { req, events } = baseReq({ eventId: "ev1" });
    await runAgentRequest(req, { createStream, tools: [send] });

    expect(send.run).not.toHaveBeenCalled();
    const ask = events.find((e) => e.type === "needs_approval") as Extract<AgentSseEvent, { type: "needs_approval" }>;
    expect(ask).toBeDefined();
    expect(ask.label).toBe("Send a bulk email");
    // The model's own confirm flag was stripped before the call was shown.
    expect(ask.input).toEqual({ eventId: "ev1", recipientType: "speakers", subject: "Hi", message: "<p>x</p>" });
    expect(ask.token.split(".")).toHaveLength(2);
    const result = events.find((e) => e.type === "tool_result") as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(result.result).toMatchObject({ code: "APPROVAL_REQUIRED" });
    const block = (calls[1].messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>)[0];
    expect(block.is_error).toBeUndefined();
    expect(block.content).toContain("APPROVAL_REQUIRED");
  });

  it("runs an approved call first with confirm set, then lets the model summarise", async () => {
    const send = fakeTool("send_bulk_email", { sent: 200 });
    const { createStream, calls } = scripted([{ blocks: [{ type: "text", text: "Sent." } as Block], stop: "end_turn", text: "Sent." }]);
    const { req, events } = baseReq({
      eventId: "ev1",
      message: "Approved: Send a bulk email.",
      approvedCall: { toolName: "send_bulk_email", input: { eventId: "ev1", recipientType: "speakers", subject: "Hi", message: "x" } },
    });
    await runAgentRequest(req, { createStream, tools: [send] });

    expect(send.run).toHaveBeenCalledTimes(1);
    expect(send.run).toHaveBeenCalledWith({ eventId: "ev1", recipientType: "speakers", subject: "Hi", message: "x", confirm: true });
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "text_delta"]);
    expect(events.some((e) => e.type === "needs_approval")).toBe(false);
    const first = calls[0].messages.at(-1)!;
    expect(first.role).toBe("user");
    expect(String(first.content)).toContain("The person approved send_bulk_email");
    expect(String(first.content)).toContain("[BEGIN TOOL DATA: send_bulk_email]");
  });

  it("an approved call still passes the role gate", async () => {
    const send = fakeTool("send_bulk_email", { sent: 1 });
    const { createStream } = scripted([{ blocks: [], stop: "end_turn" }]);
    const { req, events } = baseReq({
      readOnly: true,
      actor: { userId: "m1", role: "MEMBER", fromApiKey: false },
      approvedCall: { toolName: "send_bulk_email", input: { eventId: "ev1" } },
    });
    await runAgentRequest(req, { createStream, tools: [send] });
    expect(send.run).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === "tool_result") as Extract<AgentSseEvent, { type: "tool_result" }>;
    expect(result.result).toMatchObject({ code: "READ_ONLY_ROLE" });
  });

  it("does not pause an ordinary write", async () => {
    const track = fakeTool("create_track", { success: true });
    const { createStream } = scripted([
      { blocks: [toolUse("create_track", { eventId: "ev1", name: "T" })], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const { req, events } = baseReq();
    await runAgentRequest(req, { createStream, tools: [track] });
    expect(track.run).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "needs_approval")).toBe(false);
  });
});

describe("runAgentRequest stored-run recording", () => {
  function recorder() {
    return { id: "run1", step: vi.fn(), turn: vi.fn(), finish: vi.fn(async () => {}) };
  }

  it("records one step per tool call with the outcome, the write flag, a code and the tool's input, never the result", async () => {
    const list = fakeTool("list_events", [{ id: "e1", name: "Dr Jane Smith summit" }]);
    const create = fakeTool("create_event", { success: true });
    const failing: RegisteredTool = {
      ...fakeTool("create_track", {}),
      run: vi.fn(async () => ({ text: JSON.stringify({ error: "Track for jane@x.com exists", code: "TRACK_EXISTS" }), isError: true })),
    };
    const { createStream } = scripted([
      {
        blocks: [
          toolUse("list_events", {}, "a"),
          toolUse("create_event", { name: "Summit" }, "b"),
          toolUse("create_track", { eventId: "e1", name: "T" }, "c"),
          toolUse("frobnicate", {}, "d"),
          toolUse("send_bulk_email", { eventId: "e1" }, "e"),
        ],
        stop: "tool_use",
      },
      { blocks: [], stop: "end_turn" },
    ]);
    const run = recorder();
    const { req } = baseReq({ run });
    process.env.NEXTAUTH_SECRET ??= "test-secret-for-approval-tokens";
    const ended = await runAgentRequest(req, { createStream, tools: [list, create, failing, fakeTool("send_bulk_email", {})] });

    expect(ended).toBe("completed");
    const steps = run.step.mock.calls.map((c) => c[0]);
    expect(steps.map((s) => [s.tool, s.outcome, s.code ?? null, s.write, s.approved])).toEqual([
      ["list_events", "RAN", null, false, false],
      ["create_event", "RAN", null, true, false],
      ["create_track", "ERROR", "TRACK_EXISTS", true, false],
      ["frobnicate", "UNKNOWN_TOOL", "UNKNOWN_TOOL", true, false],
      ["send_bulk_email", "APPROVAL_REQUESTED", "APPROVAL_REQUIRED", true, false],
    ]);
    for (const s of steps) expect(typeof s.durationMs).toBe("number");
    // The input rides on the step (owner decision, Sep 21, 2026)...
    expect(steps[1].input).toEqual({ name: "Summit" });
    expect(steps[2].input).toEqual({ eventId: "e1", name: "T" });
    // ...and the RESULT never does: neither the name a read returned nor the
    // address in a tool's error text reaches the recorder.
    const serialized = JSON.stringify(steps);
    expect(serialized).toContain("Summit");
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("jane@x.com");
    expect(run.turn).toHaveBeenCalledTimes(2);
  });

  it("records a refusal with the gate's code and an approved call as approved", async () => {
    const send = fakeTool("send_bulk_email", { sent: 1 });
    const create = fakeTool("create_event", {});
    const { createStream } = scripted([
      { blocks: [toolUse("create_event", { name: "X" })], stop: "tool_use" },
      { blocks: [], stop: "end_turn" },
    ]);
    const run = recorder();
    const { req } = baseReq({
      run,
      readOnly: true,
      actor: { userId: "m1", role: "MEMBER", fromApiKey: false },
      approvedCall: { toolName: "send_bulk_email", input: { eventId: "e1" } },
    });
    await runAgentRequest(req, { createStream, tools: [send, create] });
    const steps = run.step.mock.calls.map((c) => c[0]);
    // The approved call runs first; a MEMBER's approved write is still refused by the gate.
    expect(steps[0]).toMatchObject({ tool: "send_bulk_email", outcome: "REFUSED", code: "READ_ONLY_ROLE", approved: true });
    expect(steps[1]).toMatchObject({ tool: "create_event", outcome: "REFUSED", code: "READ_ONLY_ROLE", approved: false });
  });

  it("reports the step limit as its own ending and hands each turn's usage to the recorder", async () => {
    const t = fakeTool("list_events", []);
    const { createStream } = scripted([{ blocks: [toolUse("list_events", {})], stop: "tool_use" }]);
    const run = recorder();
    const { req } = baseReq({ run });
    const ended = await runAgentRequest(req, { createStream, tools: [t] });
    expect(ended).toBe("turn_limit");
    expect(run.turn).toHaveBeenCalledTimes(MAX_TURNS);
    expect(run.step).toHaveBeenCalledTimes(MAX_TURNS);
  });
});
