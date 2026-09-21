/**
 * The Event Agent's stored-run recorder: names, counts, tokens and outcomes
 * reach the tables, and since the messages page (owner decision, Sep 21,
 * 2026) the message, the reply and each tool's input do too, bounded; tool
 * RESULTS still never do. Every write is failure-isolated, because a run that
 * cannot be recorded must still run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockLogger, lanes } = vi.hoisted(() => ({
  mockDb: {
    agentRun: { create: vi.fn(), updateMany: vi.fn() },
    agentStep: { create: vi.fn() },
  },
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  lanes: [] as string[],
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: async (orgId: string, fn: () => Promise<unknown>) => {
    lanes.push(orgId);
    return fn();
  },
}));

import {
  startAgentRun,
  NOOP_RECORDER,
  sanitizeStepCode,
  stepCodeFromResult,
  countStep,
  emptyCounters,
  boundStepInput,
  MAX_STORED_MESSAGE_LENGTH,
  MAX_STORED_REPLY_LENGTH,
  MAX_STORED_INPUT_CHARS,
} from "@/lib/agent/run-store";

const START = {
  organizationId: "org1",
  userId: "u1",
  role: "ADMIN",
  eventId: null,
  route: "org" as const,
  message: "find the summit",
  messageLength: 42,
  historyPairs: 3,
  approvedTool: null,
  model: "claude-x",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  lanes.length = 0;
  mockDb.agentRun.create.mockResolvedValue({ id: "run1" });
  mockDb.agentRun.updateMany.mockResolvedValue({ count: 1 });
  mockDb.agentStep.create.mockResolvedValue({ id: "s" });
});

describe("startAgentRun", () => {
  it("creates the run on the actor's lane with the message and its length", async () => {
    const run = await startAgentRun(START);
    expect(run.id).toBe("run1");
    expect(lanes).toEqual(["org1"]);
    const data = mockDb.agentRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ organizationId: "org1", userId: "u1", role: "ADMIN", route: "org", message: "find the summit", messageLength: 42, historyPairs: 3, source: "agent", model: "claude-x" });
  });

  it("cuts a message past the storage bound rather than failing the insert", async () => {
    await startAgentRun({ ...START, message: "x".repeat(MAX_STORED_MESSAGE_LENGTH + 500) });
    const data = mockDb.agentRun.create.mock.calls[0][0].data;
    expect(data.message).toHaveLength(MAX_STORED_MESSAGE_LENGTH);
  });

  it("hands back a no-op recorder when the insert fails, and the request goes on", async () => {
    mockDb.agentRun.create.mockRejectedValueOnce(new Error("pool"));
    const run = await startAgentRun(START);
    expect(run).toBe(NOOP_RECORDER);
    expect(run.id).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-run:start-failed" }));
    run.step({ tool: "x", outcome: "RAN", write: false, approved: false, durationMs: 1 });
    await run.finish("COMPLETED");
    expect(mockDb.agentStep.create).not.toHaveBeenCalled();
    expect(mockDb.agentRun.updateMany).not.toHaveBeenCalled();
  });
});

describe("the recorder", () => {
  it("writes each step in order on the run's lane, with the code and the input, never a result", async () => {
    const run = await startAgentRun(START);
    run.step({ tool: "list_events", outcome: "RAN", write: false, approved: false, durationMs: 12.6 });
    run.step({ tool: "create_event", outcome: "ERROR", code: "EVENT_CODE_TAKEN", write: true, approved: false, durationMs: 30, input: { name: "Summit", code: "SUM26" } });
    await flush();
    expect(mockDb.agentStep.create).toHaveBeenCalledTimes(2);
    const [a, b] = mockDb.agentStep.create.mock.calls.map((c) => c[0].data);
    // No input handed in: no input key on the row, so the column stays NULL.
    expect(a).toEqual({ runId: "run1", organizationId: "org1", seq: 0, tool: "list_events", outcome: "RAN", code: null, write: false, approved: false, durationMs: 13 });
    expect(b).toMatchObject({ seq: 1, tool: "create_event", outcome: "ERROR", code: "EVENT_CODE_TAKEN", write: true, input: { name: "Summit", code: "SUM26" } });
    expect(lanes.every((l) => l === "org1")).toBe(true);
  });

  it("the stored reply is what finish is handed, cut at the bound, null when empty", async () => {
    const run = await startAgentRun(START);
    await run.finish("COMPLETED", undefined, { reply: "Created the event." });
    expect(mockDb.agentRun.updateMany.mock.calls[0][0].data.reply).toBe("Created the event.");

    const long = await startAgentRun(START);
    await long.finish("COMPLETED", undefined, { reply: "y".repeat(MAX_STORED_REPLY_LENGTH + 1) });
    expect(mockDb.agentRun.updateMany.mock.calls[1][0].data.reply).toHaveLength(MAX_STORED_REPLY_LENGTH);

    const none = await startAgentRun(START);
    await none.finish("ERROR", "provider", { reply: "" });
    expect(mockDb.agentRun.updateMany.mock.calls[2][0].data.reply).toBeNull();
  });

  it("a failed step write is logged and swallowed", async () => {
    const run = await startAgentRun(START);
    mockDb.agentStep.create.mockRejectedValueOnce(new Error("gone"));
    run.step({ tool: "list_events", outcome: "RAN", write: false, approved: false, durationMs: 1 });
    await flush();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-run:step-write-failed", runId: "run1" }));
  });

  it("finish writes the counters, the tokens and the outcome by compound org-bound updateMany, once", async () => {
    const run = await startAgentRun(START);
    run.step({ tool: "list_events", outcome: "RAN", write: false, approved: false, durationMs: 1 });
    run.step({ tool: "create_track", outcome: "RAN", write: true, approved: false, durationMs: 1 });
    run.step({ tool: "send_bulk_email", outcome: "APPROVAL_REQUESTED", code: "APPROVAL_REQUIRED", write: true, approved: false, durationMs: 1 });
    run.step({ tool: "send_bulk_email", outcome: "RAN", write: true, approved: true, durationMs: 1 });
    run.step({ tool: "delete_room_type", outcome: "REFUSED", code: "WRITE_LIMIT", write: true, approved: false, durationMs: 1 });
    run.step({ tool: "frobnicate", outcome: "UNKNOWN_TOOL", code: "UNKNOWN_TOOL", write: true, approved: false, durationMs: 1 });
    run.turn({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: null });
    run.turn({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 });
    run.turn(undefined);
    await run.finish("COMPLETED");
    await run.finish("ERROR", "unexpected");
    expect(mockDb.agentRun.updateMany).toHaveBeenCalledTimes(1);
    const call = mockDb.agentRun.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "run1", organizationId: "org1" });
    expect(call.data).toMatchObject({
      outcome: "COMPLETED",
      errorClass: null,
      turns: 3,
      toolCalls: 6,
      writes: 2,
      refusals: 1,
      approvalsRequested: 1,
      approvalsRun: 1,
      toolErrors: 1,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 10000,
      cacheCreationTokens: 200,
    });
    expect(call.data.finishedAt).toBeInstanceOf(Date);
    expect(typeof call.data.durationMs).toBe("number");
    // finish without a reply writes NULL, never undefined (Prisma would skip it).
    expect(call.data.reply).toBeNull();
  });

  it("finish records the error class and never throws", async () => {
    const run = await startAgentRun(START);
    mockDb.agentRun.updateMany.mockRejectedValueOnce(new Error("down"));
    await expect(run.finish("ERROR", "provider")).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-run:finish-failed" }));
  });

  it("a finish that matched no row is logged, since the org bind is part of the write", async () => {
    const run = await startAgentRun(START);
    mockDb.agentRun.updateMany.mockResolvedValueOnce({ count: 0 });
    await run.finish("COMPLETED");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "agent-run:finish-missed" }));
  });
});

describe("step codes", () => {
  it("keeps identifiers and drops anything that could be text", () => {
    expect(sanitizeStepCode("READ_ONLY_ROLE")).toBe("READ_ONLY_ROLE");
    expect(sanitizeStepCode("P2002")).toBe("P2002");
    expect(sanitizeStepCode("Dr Smith cannot be found")).toBeNull();
    expect(sanitizeStepCode("a@b.com")).toBeNull();
    expect(sanitizeStepCode("")).toBeNull();
    expect(sanitizeStepCode(42)).toBeNull();
    expect(sanitizeStepCode("X".repeat(41))).toBeNull();
  });

  it("reads a tool's code from its JSON result and ignores everything else in it", () => {
    expect(stepCodeFromResult(JSON.stringify({ error: "Speaker jane@x.com already exists", code: "SPEAKER_ALREADY_EXISTS" }))).toBe("SPEAKER_ALREADY_EXISTS");
    expect(stepCodeFromResult(JSON.stringify({ error: "boom" }))).toBeNull();
    expect(stepCodeFromResult("not json")).toBeNull();
    expect(stepCodeFromResult("null")).toBeNull();
  });
});

describe("boundStepInput", () => {
  it("passes plain JSON through and drops what JSON cannot carry", () => {
    expect(boundStepInput({ eventId: "e1", tags: ["a"], n: 1, fn: () => 1, u: undefined })).toEqual({ eventId: "e1", tags: ["a"], n: 1 });
  });
  it("writes nothing for a missing or null input", () => {
    expect(boundStepInput(undefined)).toBeUndefined();
    expect(boundStepInput(null)).toBeUndefined();
  });
  it("replaces an oversized input with a marker that says how big it was", () => {
    const big = { rows: "z".repeat(MAX_STORED_INPUT_CHARS) };
    const out = boundStepInput(big) as { truncated: boolean; chars: number };
    expect(out.truncated).toBe(true);
    expect(out.chars).toBeGreaterThan(MAX_STORED_INPUT_CHARS);
  });
  it("marks an input that cannot be serialised instead of throwing", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(boundStepInput(loop)).toEqual({ unserializable: true });
  });
});

describe("countStep", () => {
  it("counts a refused write as a refusal, not a write", () => {
    const c = emptyCounters();
    countStep(c, { tool: "t", outcome: "REFUSED", write: true, approved: false, durationMs: 0 });
    expect(c).toMatchObject({ toolCalls: 1, writes: 0, refusals: 1, toolErrors: 0 });
  });
  it("counts an approved call that errored as run and errored", () => {
    const c = emptyCounters();
    countStep(c, { tool: "t", outcome: "ERROR", write: true, approved: true, durationMs: 0 });
    expect(c).toMatchObject({ toolCalls: 1, writes: 1, approvalsRun: 1, toolErrors: 1 });
  });
});
