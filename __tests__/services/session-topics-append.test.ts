/**
 * appendSessionTopics (Nov 12, 2026): the one place a topic is added to a
 * session that already exists. Two callers: the agent's add_topic_to_session
 * and the agenda CSV import, which adds the topics a re-imported file carries
 * for a session already on the event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => {
  const tx = {
    eventSession: { update: vi.fn() },
    sessionTopic: { findMany: vi.fn(), create: vi.fn() },
  };
  return {
    mockDb: {
      eventSession: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn() },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (tx: unknown) => unknown, opts?: unknown) =>
    (mockDb.$transaction as (cb: (tx: unknown) => unknown, opts?: unknown) => unknown)(cb, opts),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));

import { appendSessionTopics, selectTopicsToAppend } from "@/services/session-service";

const BASE = { eventId: "ev1", organizationId: "org1", sessionId: "s1", actorUserId: "u1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", name: "Plenary 1", type: "SESSION" });
  mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }, { id: "sp2" }]);
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb._tx.eventSession.update.mockResolvedValue({ id: "s1" });
  mockDb._tx.sessionTopic.findMany.mockResolvedValue([]);
  let n = 0;
  mockDb._tx.sessionTopic.create.mockImplementation(async ({ data }: { data: { title: string; duration: number | null } }) => ({
    id: `t${++n}`,
    title: data.title,
    duration: data.duration,
    speakers: [],
  }));
});

describe("selectTopicsToAppend", () => {
  const titles = (list: { title: string }[]) => list.map((t) => t.title);

  it("leaves out titles the session already has, ignoring case and spacing", () => {
    const incoming = [{ title: "heart  FAILURE update " }, { title: "New lipid targets" }];
    expect(titles(selectTopicsToAppend(["Heart failure update"], incoming))).toEqual(["New lipid targets"]);
  });

  it("counts repeats: two Discussions on the session and three in the file adds one", () => {
    const incoming = [{ title: "Talk A" }, { title: "Discussion" }, { title: "Discussion" }, { title: "Discussion" }];
    expect(titles(selectTopicsToAppend(["Talk A", "Discussion", "discussion"], incoming))).toEqual(["Discussion"]);
  });

  it("an empty session takes every topic, repeats included, in order", () => {
    const incoming = [{ title: "A" }, { title: "Q&A" }, { title: "B" }, { title: "Q&A" }];
    expect(titles(selectTopicsToAppend([], incoming))).toEqual(["A", "Q&A", "B", "Q&A"]);
  });
});

describe("appendSessionTopics", () => {
  it("appends after the last position, stamps the tenant on topic and speakers, audits once", async () => {
    mockDb._tx.sessionTopic.findMany.mockResolvedValue([
      { title: "Opening", sortOrder: 0 },
      { title: "Closing", sortOrder: 7 },
    ]);

    const res = await appendSessionTopics({
      ...BASE,
      requestIp: "1.2.3.4",
      topics: [
        { title: "Talk A", duration: 20, speakerIds: ["sp1", "sp1", "sp2"] },
        { title: "Talk B" },
      ],
    });

    expect(res).toMatchObject({ ok: true, sessionName: "Plenary 1", alreadyPresent: 0 });
    expect(mockDb._tx.sessionTopic.create).toHaveBeenCalledTimes(2);
    expect(mockDb._tx.sessionTopic.create.mock.calls[0][0].data).toEqual({
      sessionId: "s1",
      organizationId: "org1",
      title: "Talk A",
      duration: 20,
      sortOrder: 8,
      speakers: {
        create: [
          { speakerId: "sp1", organizationId: "org1" },
          { speakerId: "sp2", organizationId: "org1" },
        ],
      },
    });
    expect(mockDb._tx.sessionTopic.create.mock.calls[1][0].data).toMatchObject({
      title: "Talk B",
      duration: null,
      sortOrder: 9,
      speakers: undefined,
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create.mock.calls[0][0].data).toMatchObject({
      eventId: "ev1",
      userId: "u1",
      action: "CREATE",
      entityType: "SessionTopic",
      entityId: "s1",
      changes: { source: "rest", ip: "1.2.3.4", topics: [{ id: "t1", title: "Talk A" }, { id: "t2", title: "Talk B" }] },
    });
  });

  it("touches the session row FIRST: the row lock orders two appends and a stale edit dialog gets STALE_WRITE", async () => {
    const order: string[] = [];
    mockDb._tx.eventSession.update.mockImplementation(async () => {
      order.push("touch");
      return { id: "s1" };
    });
    mockDb._tx.sessionTopic.findMany.mockImplementation(async () => {
      order.push("read");
      return [];
    });

    await appendSessionTopics({ ...BASE, topics: [{ title: "Talk A" }] });

    expect(order).toEqual(["touch", "read"]);
    const touch = mockDb._tx.eventSession.update.mock.calls[0][0];
    expect(touch.where).toEqual({ id: "s1" });
    expect(touch.data.updatedAt).toBeInstanceOf(Date);
  });

  it("onlyMissingTitles: adds what the session lacks and reports the rest", async () => {
    mockDb._tx.sessionTopic.findMany.mockResolvedValue([{ title: "talk a", sortOrder: 0 }]);

    const res = await appendSessionTopics({
      ...BASE,
      onlyMissingTitles: true,
      topics: [{ title: "Talk A" }, { title: "Talk B" }],
    });

    expect(res).toMatchObject({ ok: true, alreadyPresent: 1 });
    expect(mockDb._tx.sessionTopic.create).toHaveBeenCalledTimes(1);
    expect(mockDb._tx.sessionTopic.create.mock.calls[0][0].data).toMatchObject({ title: "Talk B", sortOrder: 1 });
  });

  it("onlyMissingTitles with nothing missing: no topic, no audit row", async () => {
    mockDb._tx.sessionTopic.findMany.mockResolvedValue([{ title: "Talk A", sortOrder: 0 }]);

    const res = await appendSessionTopics({ ...BASE, onlyMissingTitles: true, topics: [{ title: "Talk A" }] });

    expect(res).toMatchObject({ ok: true, added: [], alreadyPresent: 1 });
    expect(mockDb._tx.sessionTopic.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("without onlyMissingTitles (the agent) a repeated title is added", async () => {
    mockDb._tx.sessionTopic.findMany.mockResolvedValue([{ title: "Discussion", sortOrder: 0 }]);

    const res = await appendSessionTopics({ ...BASE, topics: [{ title: "Discussion" }] });

    expect(res).toMatchObject({ ok: true, alreadyPresent: 0 });
    expect(mockDb._tx.sessionTopic.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a break item, an unknown session and an unknown speaker before any write, each logged", async () => {
    mockDb.eventSession.findFirst.mockResolvedValueOnce({ id: "s1", name: "Lunch", type: "LUNCH" });
    expect(await appendSessionTopics({ ...BASE, topics: [{ title: "T" }] })).toMatchObject({
      ok: false,
      code: "BREAK_ITEM_HAS_PROGRAM",
    });

    mockDb.eventSession.findFirst.mockResolvedValueOnce(null);
    expect(await appendSessionTopics({ ...BASE, topics: [{ title: "T" }] })).toMatchObject({
      ok: false,
      code: "SESSION_NOT_FOUND",
    });

    mockDb.speaker.findMany.mockResolvedValueOnce([{ id: "sp1" }]);
    expect(await appendSessionTopics({ ...BASE, topics: [{ title: "T", speakerIds: ["sp1", "ghost"] }] })).toMatchObject({
      ok: false,
      code: "SPEAKER_NOT_FOUND",
      meta: { missingSpeakerIds: ["ghost"] },
    });

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalledTimes(3);
  });

  it("a workshop takes topics: only break items are refused", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", name: "Hands-on", type: "WORKSHOP" });
    expect(await appendSessionTopics({ ...BASE, topics: [{ title: "T" }] })).toMatchObject({ ok: true });
  });

  it("a database failure is an error value, logged at error", async () => {
    mockDb._tx.sessionTopic.create.mockRejectedValue(new Error("boom"));

    expect(await appendSessionTopics({ ...BASE, topics: [{ title: "T" }] })).toMatchObject({ ok: false, code: "UNKNOWN" });
    expect(mockApiLogger.error).toHaveBeenCalledTimes(1);
  });
});

describe("the agent's add_topic_to_session goes through the service and keeps its answer", () => {
  const ctx = { eventId: "ev1", userId: "u1", organizationId: "org1", source: "mcp" } as never;

  it("returns the topic with speaker names and the session's name", async () => {
    const { SESSION_EXECUTORS } = await import("@/lib/agent/tools/sessions");
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }]);
    mockDb._tx.sessionTopic.create.mockResolvedValue({
      id: "t1",
      title: "Talk A",
      duration: 20,
      speakers: [{ speaker: { firstName: "Jane", lastName: "Doe" } }],
    });

    const res = await SESSION_EXECUTORS.add_topic_to_session(
      { sessionId: "s1", title: " Talk A ", duration: "20", speakerIds: ["sp1"] },
      ctx,
    );

    expect(res).toEqual({
      success: true,
      topic: { id: "t1", title: "Talk A", duration: 20, speakers: ["Jane Doe"] },
      session: "Plenary 1",
    });
    expect(mockDb._tx.sessionTopic.create.mock.calls[0][0].data).toMatchObject({ title: "Talk A", duration: 20 });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.source).toBe("mcp");
  });

  it("an unknown speaker comes back as the tool's error, with the code", async () => {
    const { SESSION_EXECUTORS } = await import("@/lib/agent/tools/sessions");
    mockDb.speaker.findMany.mockResolvedValue([]);

    const res = await SESSION_EXECUTORS.add_topic_to_session({ sessionId: "s1", title: "T", speakerIds: ["ghost"] }, ctx);

    expect(res).toEqual({ error: "Speaker IDs not found: ghost", code: "SPEAKER_NOT_FOUND" });
  });
});
