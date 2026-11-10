/**
 * Agent tool refusals: one log row each, and the row names the caller.
 *
 * An audit of production warnings (Nov 10, 2026) found two things. The
 * "MCP tool validation-error" line, written for every refusal a tool returns
 * as an error value, carried the tool, event and organisation but not who was
 * refused. And every agent speaker update without a version token wrote the
 * "optimistic-lock:missing-expectedUpdatedAt" warning twice: once in the tool
 * and once more in runOptimisticUpdate, which the service calls a line later.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockApiLogger, mockUpdateSpeaker, mockExecutor, mockDb } = vi.hoisted(() => ({
  mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockUpdateSpeaker: vi.fn(),
  mockExecutor: vi.fn(),
  mockDb: { speaker: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/db", () => ({ db: mockDb, dbOperator: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/services/speaker-service", () => ({
  createSpeaker: vi.fn(),
  updateSpeaker: mockUpdateSpeaker,
}));
vi.mock("@/lib/agent/event-tools", () => ({
  TOOL_EXECUTOR_MAP: { update_contact: mockExecutor },
}));

import { SPEAKER_EXECUTORS } from "@/lib/agent/tools/speakers";
import type { AgentContext } from "@/lib/agent/tools/_shared";

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

/** The real registrations, handed to a stub server that keeps each handler. */
async function registeredHandlers(systemUserId: string): Promise<Map<string, ToolHandler>> {
  const handlers = new Map<string, ToolHandler>();
  const stub = {
    tool: (name: string, ...rest: unknown[]) => void handlers.set(name, rest[rest.length - 1] as ToolHandler),
    resource: () => {},
    prompt: () => {},
  };
  const { registerAllMcpTools } = await import("@/lib/agent/register-mcp-tools");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAllMcpTools(stub as any, "org1", { systemUserId, source: "agent" });
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP tool validation-error names the caller", () => {
  it("logs the refusal once, at warn, with the userId from the tool context", async () => {
    mockExecutor.mockResolvedValue({ error: "Contact c1 not found", code: "CONTACT_NOT_FOUND" });
    const handlers = await registeredHandlers("user-42");

    await handlers.get("update_contact")!({ contactId: "c1" });

    const refusals = mockApiLogger.warn.mock.calls.filter(([row]) => row?.msg === "MCP tool validation-error");
    expect(refusals).toHaveLength(1);
    expect(refusals[0][0]).toMatchObject({
      tool: "update_contact",
      organizationId: "org1",
      userId: "user-42",
      source: "agent",
      err: "Contact c1 not found",
      code: "CONTACT_NOT_FOUND",
    });
  });
});

describe("agent update_speaker without a version token", () => {
  const ctx: AgentContext = {
    eventId: "ev1",
    organizationId: "org1",
    userId: "u1",
    source: "agent",
    counters: { creates: 0, emailsSent: 0 },
  };

  it("writes no missing-token warning of its own (the shared helper writes the one row)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", eventId: "ev1" });
    // The service is mocked, so the helper never runs: any warning seen here
    // would be the tool's own duplicate.
    mockUpdateSpeaker.mockResolvedValue({ ok: false, code: "NO_FIELDS", message: "No fields provided to update" });

    await SPEAKER_EXECUTORS.update_speaker({ speakerId: "spk1", firstName: "Ada" }, ctx);

    expect(mockUpdateSpeaker).toHaveBeenCalledTimes(1);
    expect(mockUpdateSpeaker.mock.calls[0][0]).toMatchObject({
      expectedUpdatedAt: null,
      source: "agent",
      actorUserId: "u1",
    });
    const lockWarnings = mockApiLogger.warn.mock.calls.filter(
      ([row]) => row?.msg === "optimistic-lock:missing-expectedUpdatedAt",
    );
    expect(lockWarnings).toHaveLength(0);
  });
});
