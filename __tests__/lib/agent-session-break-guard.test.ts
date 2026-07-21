/**
 * H1 (break-items review): the per-speaker/topic MCP executors bypass the
 * session service, so they must enforce the break-item invariant themselves —
 * without this gate an MCP client could attach a speaker or topic to a coffee
 * break, which every renderer hides and the next dashboard save silently wipes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    eventSession: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), findMany: vi.fn() },
    sessionSpeaker: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    sessionTopic: { aggregate: vi.fn(), create: vi.fn() },
    topicSpeaker: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SESSION_EXECUTORS } from "@/lib/agent/tools/sessions";

// ToolExecutor returns `unknown` — narrow to a plain record for assertions.
type ToolResult = Record<string, unknown>;

const ctx = { eventId: "ev1", userId: "u1", organizationId: "org1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
});

describe("MCP roster tools refuse break items", () => {
  it("add_speaker_to_session → BREAK_ITEM_HAS_PROGRAM", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "LUNCH" });
    const res = (await SESSION_EXECUTORS.add_speaker_to_session(
      { sessionId: "s1", speakerId: "sp1" },
      ctx,
    )) as ToolResult;
    expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
    expect(mockDb.sessionSpeaker.upsert).not.toHaveBeenCalled();
  });

  it("add_topic_to_session → BREAK_ITEM_HAS_PROGRAM", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", name: "Coffee", type: "BREAK" });
    const res = (await SESSION_EXECUTORS.add_topic_to_session(
      { sessionId: "s1", title: "T" },
      ctx,
    )) as ToolResult;
    expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("replace_session_speakers with a non-empty roster → BREAK_ITEM_HAS_PROGRAM", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "REGISTRATION" });
    const res = (await SESSION_EXECUTORS.replace_session_speakers(
      { sessionId: "s1", assignments: [{ speakerId: "sp1" }] },
      ctx,
    )) as ToolResult;
    expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("replace_session_speakers with an EMPTY roster is allowed (cleanup)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "BREAK" });
    mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        sessionSpeaker: {
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        topicSpeaker: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    );
    const res = (await SESSION_EXECUTORS.replace_session_speakers(
      { sessionId: "s1", assignments: [] },
      ctx,
    )) as ToolResult;
    expect(res.code).toBeUndefined();
    expect(res.assignments).toEqual([]);
  });

  it("a real SESSION is untouched by the gate", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "SESSION" });
    mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1" });
    mockDb.sessionSpeaker.findUnique.mockResolvedValue(null);
    mockDb.sessionSpeaker.upsert.mockResolvedValue({ sessionId: "s1", speakerId: "sp1", role: "SPEAKER" });
    const res = (await SESSION_EXECUTORS.add_speaker_to_session(
      { sessionId: "s1", speakerId: "sp1" },
      ctx,
    )) as ToolResult;
    expect(res.code).toBeUndefined();
    expect(res.sessionSpeaker).toBeTruthy();
  });
});
