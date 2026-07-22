/**
 * session-service — the extraction that closes the program/agenda review's
 * H1 (PUT destroyed child rows before checking the optimistic lock, and did so
 * non-transactionally) and H4 (no service: MCP create_session wrote no audit
 * row, sent no admin notification, and dropped status/abstractId/sortOrder;
 * capacity + zero-duration rules disagreed between REST and MCP).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb, mockTx, mockApiLogger, mockNotify, mockRefreshStats } = vi.hoisted(() => {
  const mockTx = {
    eventSession: { updateMany: vi.fn() },
    sessionSpeaker: { deleteMany: vi.fn(), createMany: vi.fn() },
    sessionTopic: { findMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    topicSpeaker: { deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    mockTx,
    mockDb: {
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockTx)),
      event: { findUnique: vi.fn() },
      eventSession: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
      track: { findFirst: vi.fn() },
      abstract: { findFirst: vi.fn() },
      speaker: { findMany: vi.fn() },
      auditLog: { create: vi.fn() },
    },
    mockApiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockNotify: vi.fn(),
    mockRefreshStats: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: mockRefreshStats }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: mockNotify }));

import { createSession, updateSession } from "@/services/session-service";

const EVENT = {
  startDate: new Date("2026-09-01T00:00:00Z"),
  endDate: new Date("2026-09-03T00:00:00Z"),
  timezone: "Asia/Dubai",
};
const START = new Date("2026-09-02T06:00:00Z");
const END = new Date("2026-09-02T07:00:00Z");

const BASE_CREATE = {
  eventId: "ev1",
  userId: "u1",
  source: "rest" as const,
  name: "Keynote",
  startTime: START,
  endTime: END,
};
const BASE_UPDATE = {
  eventId: "ev1",
  sessionId: "s1",
  userId: "u1",
  source: "rest" as const,
};

const SESSION_ROW = { id: "s1", name: "Keynote", status: "SCHEDULED", updatedAt: new Date(0) };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findUnique.mockResolvedValue(EVENT);
  mockDb.eventSession.create.mockResolvedValue({ id: "s1" });
  mockDb.eventSession.findUnique.mockResolvedValue(SESSION_ROW);
  mockDb.eventSession.findFirst.mockResolvedValue({
    id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
    type: "SESSION", abstractId: null, _count: { speakers: 0, topics: 0 },
  });
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
  mockNotify.mockReturnValue({ catch: () => {} });
  mockTx.eventSession.updateMany.mockResolvedValue({ count: 1 });
  mockTx.sessionTopic.findMany.mockResolvedValue([]);
  mockTx.topicSpeaker.deleteMany.mockResolvedValue({ count: 0 });
});

describe("createSession — H4: side effects the MCP path used to skip", () => {
  it("writes an audit row tagged with the caller source", async () => {
    const res = await createSession({ ...BASE_CREATE, source: "mcp" });
    expect(res.ok).toBe(true);
    const audit = mockDb.auditLog.create.mock.calls[0][0];
    expect(audit.data.action).toBe("CREATE");
    expect(audit.data.entityType).toBe("EventSession");
    expect(audit.data.changes.source).toBe("mcp");
  });

  it("notifies event admins (MCP-created sessions used to be silent)", async () => {
    await createSession({ ...BASE_CREATE, source: "mcp" });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1].message).toContain("via the AI agent");
  });

  it("refreshes event stats", async () => {
    await createSession(BASE_CREATE);
    expect(mockRefreshStats).toHaveBeenCalledWith("ev1");
  });

  it("persists status (MCP used to drop it) and defaults to SCHEDULED", async () => {
    await createSession({ ...BASE_CREATE, status: "DRAFT" });
    expect(mockDb.eventSession.create.mock.calls[0][0].data.status).toBe("DRAFT");
    vi.clearAllMocks();
    mockDb.event.findUnique.mockResolvedValue(EVENT);
    mockDb.eventSession.create.mockResolvedValue({ id: "s1" });
    mockDb.eventSession.findUnique.mockResolvedValue(SESSION_ROW);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
    mockNotify.mockReturnValue({ catch: () => {} });
    await createSession(BASE_CREATE);
    expect(mockDb.eventSession.create.mock.calls[0][0].data.status).toBe("SCHEDULED");
  });

  it("honours client-supplied topic sortOrder, else falls back to index (MCP used to drop it)", async () => {
    await createSession({
      ...BASE_CREATE,
      topics: [{ title: "A", sortOrder: 5 }, { title: "B" }],
    });
    const topics = mockDb.eventSession.create.mock.calls[0][0].data.topics.create;
    expect(topics[0].sortOrder).toBe(5);
    expect(topics[1].sortOrder).toBe(1);
  });

  it("sessionRoles take precedence over the legacy flat speakerIds", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }, { id: "sp2" }]);
    await createSession({
      ...BASE_CREATE,
      speakerIds: ["sp2"],
      sessionRoles: [{ speakerId: "sp1", role: "MODERATOR" }],
    });
    const speakers = mockDb.eventSession.create.mock.calls[0][0].data.speakers.create;
    expect(speakers).toEqual([{ speakerId: "sp1", role: "MODERATOR" }]);
  });
});

describe("validation — one rule set for both callers", () => {
  it("rejects a zero-duration session (MCP update used to allow endTime === startTime)", async () => {
    const res = await createSession({ ...BASE_CREATE, endTime: START });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID_TIME_RANGE");
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });

  it("rejects capacity 0 (MCP update used to allow it via Math.max(0, …))", async () => {
    const res = await createSession({ ...BASE_CREATE, capacity: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID_CAPACITY");
  });

  it("rejects a session outside the event's dates (in the event timezone)", async () => {
    const res = await createSession({
      ...BASE_CREATE,
      startTime: new Date("2026-09-09T06:00:00Z"),
      endTime: new Date("2026-09-09T07:00:00Z"),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("OUTSIDE_EVENT_DATES");
  });

  it("rejects an abstract already assigned to another session", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1" });
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "other" });
    const res = await createSession({ ...BASE_CREATE, abstractId: "ab1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ABSTRACT_ALREADY_ASSIGNED");
  });

  it("reports which speaker ids don't belong to the event", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }]);
    const res = await createSession({ ...BASE_CREATE, speakerIds: ["sp1", "ghost"] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("SPEAKERS_NOT_FOUND");
      expect(res.meta?.missing).toEqual(["ghost"]);
    }
  });
});

describe("break items — a break-like type may never end up with program content", () => {
  it("create persists the type, defaulting to SESSION", async () => {
    await createSession({ ...BASE_CREATE, type: "BREAK", name: "Coffee Break" });
    expect(mockDb.eventSession.create.mock.calls[0][0].data.type).toBe("BREAK");
    vi.clearAllMocks();
    mockDb.event.findUnique.mockResolvedValue(EVENT);
    mockDb.eventSession.create.mockResolvedValue({ id: "s1" });
    mockDb.eventSession.findUnique.mockResolvedValue(SESSION_ROW);
    mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
    mockNotify.mockReturnValue({ catch: () => {} });
    await createSession(BASE_CREATE);
    expect(mockDb.eventSession.create.mock.calls[0][0].data.type).toBe("SESSION");
  });

  it("rejects creating a break item with speakers", async () => {
    const res = await createSession({
      ...BASE_CREATE,
      type: "LUNCH",
      sessionRoles: [{ speakerId: "sp1", role: "SPEAKER" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });

  it("rejects creating a break item with topics or an abstract", async () => {
    const withTopics = await createSession({
      ...BASE_CREATE,
      type: "REGISTRATION",
      topics: [{ title: "T" }],
    });
    expect(withTopics.ok).toBe(false);
    if (!withTopics.ok) expect(withTopics.code).toBe("BREAK_ITEM_HAS_PROGRAM");

    const withAbstract = await createSession({ ...BASE_CREATE, type: "BREAK", abstractId: "ab1" });
    expect(withAbstract.ok).toBe(false);
    if (!withAbstract.ok) expect(withAbstract.code).toBe("BREAK_ITEM_HAS_PROGRAM");
  });

  it("rejects converting a session that still has speakers when the payload doesn't clear them", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
      type: "SESSION", abstractId: null, _count: { speakers: 2, topics: 0 },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "BREAK" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("allows the conversion when the payload explicitly clears speakers + topics", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
      type: "SESSION", abstractId: null, _count: { speakers: 2, topics: 1 },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "LUNCH", sessionRoles: [], topics: [] });
    expect(res.ok).toBe(true);
    const claim = mockTx.eventSession.updateMany.mock.calls[0][0];
    expect(claim.data.type).toBe("LUNCH");
  });

  it("rejects adding speakers to an existing break item (type omitted from payload)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
      type: "BREAK", abstractId: null, _count: { speakers: 0, topics: 0 },
    });
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }]);
    const res = await updateSession({
      ...BASE_UPDATE,
      sessionRoles: [{ speakerId: "sp1", role: "SPEAKER" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
  });

  it("converting a break item back to SESSION is unrestricted", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
      type: "LUNCH", abstractId: null, _count: { speakers: 0, topics: 0 },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "SESSION" });
    expect(res.ok).toBe(true);
  });

  it("M2: rejects converting a session with an attached Zoom meeting", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({
      id: "s1", startTime: START, endTime: END, status: "SCHEDULED",
      type: "SESSION", abstractId: null, zoomMeeting: { id: "zm1" },
      _count: { speakers: 0, topics: 0 },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "BREAK", sessionRoles: [], topics: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("BREAK_ITEM_HAS_PROGRAM");
      expect(res.message).toContain("Zoom");
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("M3: refuses to convert the webinar anchor session", async () => {
    mockDb.event.findUnique.mockResolvedValue({
      ...EVENT,
      settings: { webinar: { sessionId: "s1" } },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "BREAK", sessionRoles: [], topics: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("WEBINAR_ANCHOR_SESSION");
  });

  it("M3: a NON-anchor session in a webinar event converts fine", async () => {
    mockDb.event.findUnique.mockResolvedValue({
      ...EVENT,
      settings: { webinar: { sessionId: "someOtherSession" } },
    });
    const res = await updateSession({ ...BASE_UPDATE, type: "BREAK", sessionRoles: [], topics: [] });
    expect(res.ok).toBe(true);
  });
});

describe("updateSession — H1: the lock is claimed BEFORE anything is mutated", () => {
  it("claims the row first, then replaces children, all in ONE transaction", async () => {
    await updateSession({
      ...BASE_UPDATE,
      expectedUpdatedAt: new Date(0),
      sessionRoles: [],
      topics: [{ title: "T" }],
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    const claim = mockTx.eventSession.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: "s1", updatedAt: new Date(0) });
    // Children were touched only after a successful claim.
    expect(mockTx.sessionTopic.deleteMany).toHaveBeenCalled();
    expect(mockTx.sessionTopic.create).toHaveBeenCalledTimes(1);
  });

  it("a LOST claim mutates NOTHING and returns STALE_WRITE (was: children already destroyed)", async () => {
    mockTx.eventSession.updateMany.mockResolvedValue({ count: 0 });
    const res = await updateSession({
      ...BASE_UPDATE,
      expectedUpdatedAt: new Date(0),
      sessionRoles: [{ speakerId: "sp1", role: "SPEAKER" }],
      topics: [{ title: "T" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("STALE_WRITE");
    // The whole point of H1: no destructive write happened.
    expect(mockTx.sessionSpeaker.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.sessionTopic.deleteMany).not.toHaveBeenCalled();
  });

  it("validates the RESULTING window when only one endpoint changes", async () => {
    // Existing 06:00–07:00; moving endTime to 05:00 must be rejected.
    const res = await updateSession({ ...BASE_UPDATE, endTime: new Date("2026-09-02T05:00:00Z") });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID_TIME_RANGE");
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("404s a session that isn't in this event", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    const res = await updateSession(BASE_UPDATE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("SESSION_NOT_FOUND");
  });

  it("writes an audit row with the caller source", async () => {
    await updateSession({ ...BASE_UPDATE, source: "mcp", name: "New" });
    const audit = mockDb.auditLog.create.mock.calls[0][0];
    expect(audit.data.action).toBe("UPDATE");
    expect(audit.data.changes.source).toBe("mcp");
  });

  it("does not open a transaction when validation fails", async () => {
    const res = await updateSession({ ...BASE_UPDATE, capacity: -5 });
    expect(res.ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("updateSession — M2: topic ids are stable across saves", () => {
  it("updates an existing topic in place instead of delete-and-recreate", async () => {
    mockTx.sessionTopic.findMany.mockResolvedValue([{ id: "t1" }, { id: "t2" }]);
    await updateSession({
      ...BASE_UPDATE,
      topics: [{ id: "t1", title: "Renamed", speakerIds: ["sp-a"] }],
    });
    // t1 kept + updated; t2 (absent from payload) deleted via notIn.
    expect(mockTx.sessionTopic.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "s1", id: { notIn: ["t1"] } },
    });
    expect(mockTx.sessionTopic.update).toHaveBeenCalledTimes(1);
    const upd = mockTx.sessionTopic.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "t1" });
    expect(upd.data.title).toBe("Renamed");
    expect(mockTx.sessionTopic.create).not.toHaveBeenCalled();
    // Per-topic speakers replaced on the kept row.
    expect(mockTx.topicSpeaker.deleteMany).toHaveBeenCalledWith({ where: { topicId: "t1" } });
    expect(mockTx.topicSpeaker.createMany).toHaveBeenCalledWith({
      data: [{ topicId: "t1", speakerId: "sp-a" }],
    });
  });

  it("ignores a foreign topic id (not this session's) and creates the topic fresh", async () => {
    mockTx.sessionTopic.findMany.mockResolvedValue([{ id: "t1" }]);
    await updateSession({
      ...BASE_UPDATE,
      topics: [{ id: "someone-elses-topic", title: "New here" }],
    });
    expect(mockTx.sessionTopic.update).not.toHaveBeenCalled();
    expect(mockTx.sessionTopic.create).toHaveBeenCalledTimes(1);
    // Nothing was kept, so every existing topic goes.
    expect(mockTx.sessionTopic.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: "s1", id: { notIn: [] } },
    });
  });

  it("a duplicated id in the payload consumes the row once (second occurrence creates)", async () => {
    mockTx.sessionTopic.findMany.mockResolvedValue([{ id: "t1" }]);
    await updateSession({
      ...BASE_UPDATE,
      topics: [
        { id: "t1", title: "First" },
        { id: "t1", title: "Second" },
      ],
    });
    expect(mockTx.sessionTopic.update).toHaveBeenCalledTimes(1);
    expect(mockTx.sessionTopic.create).toHaveBeenCalledTimes(1);
  });
});

describe("updateSession — L1: dropped session speakers drop off the topics too", () => {
  it("removes per-topic rows for speakers no longer on the session", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp-keep" }]);
    await updateSession({
      ...BASE_UPDATE,
      sessionRoles: [{ speakerId: "sp-keep", role: "SPEAKER" }],
    });
    expect(mockTx.topicSpeaker.deleteMany).toHaveBeenCalledWith({
      where: { topic: { sessionId: "s1" }, speakerId: { notIn: ["sp-keep"] } },
    });
  });

  it("clearing all session speakers clears every per-topic row", async () => {
    await updateSession({ ...BASE_UPDATE, sessionRoles: [] });
    expect(mockTx.topicSpeaker.deleteMany).toHaveBeenCalledWith({
      where: { topic: { sessionId: "s1" }, speakerId: { notIn: [] } },
    });
  });

  it("skips the roster cleanup when the payload replaces topics explicitly", async () => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp-keep" }]);
    await updateSession({
      ...BASE_UPDATE,
      sessionRoles: [{ speakerId: "sp-keep", role: "SPEAKER" }],
      topics: [],
    });
    // The only topicSpeaker.deleteMany calls allowed here are the per-kept-
    // topic replaces (none, since topics=[]), not the roster-diff cleanup.
    const cleanupCalls = mockTx.topicSpeaker.deleteMany.mock.calls.filter(
      (c) => c[0]?.where?.speakerId,
    );
    expect(cleanupCalls).toHaveLength(0);
  });
});

describe("L3: an abstract-uniqueness race maps to ABSTRACT_ALREADY_ASSIGNED, not UNKNOWN", () => {
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["abstractId"] },
    });

  it("on create", async () => {
    mockDb.abstract.findFirst.mockResolvedValue({ id: "ab1" });
    mockDb.eventSession.findFirst.mockResolvedValue(null); // pre-check passes
    mockDb.eventSession.create.mockRejectedValue(p2002());
    const res = await createSession({ ...BASE_CREATE, abstractId: "ab1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ABSTRACT_ALREADY_ASSIGNED");
  });

  it("on update (thrown inside the transaction)", async () => {
    mockDb.$transaction.mockRejectedValueOnce(p2002());
    const res = await updateSession({ ...BASE_UPDATE, name: "X" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("ABSTRACT_ALREADY_ASSIGNED");
  });

  it("an unrelated P2002 still maps to UNKNOWN", async () => {
    mockDb.eventSession.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["somethingElse"] },
      }),
    );
    const res = await createSession(BASE_CREATE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("UNKNOWN");
  });
});

describe("duplicate speaker in the roster payload (July 21, 2026 prod alert — P2002 on createMany)", () => {
  beforeEach(() => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }, { id: "sp2" }]);
  });

  it("same speaker under two DIFFERENT roles → DUPLICATE_SPEAKER_ID (400), nothing written", async () => {
    const res = await updateSession({
      ...BASE_UPDATE,
      sessionRoles: [
        { speakerId: "sp1", role: "SPEAKER" },
        { speakerId: "sp1", role: "MODERATOR" },
      ],
    });
    expect(res).toMatchObject({ ok: false, code: "DUPLICATE_SPEAKER_ID", meta: { speakerId: "sp1" } });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    // Create path shares the same validate()
    const created = await createSession({
      ...BASE_CREATE,
      sessionRoles: [
        { speakerId: "sp1", role: "SPEAKER" },
        { speakerId: "sp1", role: "PANELIST" },
      ],
    });
    expect(created).toMatchObject({ ok: false, code: "DUPLICATE_SPEAKER_ID" });
    expect(mockDb.eventSession.create).not.toHaveBeenCalled();
  });

  it("EXACT duplicate pair (same speaker, same role — a double-added row) collapses silently", async () => {
    mockTx.sessionSpeaker.createMany.mockResolvedValue({ count: 1 });
    const res = await updateSession({
      ...BASE_UPDATE,
      sessionRoles: [
        { speakerId: "sp1", role: "SPEAKER" },
        { speakerId: "sp1", role: "SPEAKER" },
        { speakerId: "sp2", role: "MODERATOR" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(mockTx.sessionSpeaker.createMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "s1", speakerId: "sp1", role: "SPEAKER" },
        { sessionId: "s1", speakerId: "sp2", role: "MODERATOR" },
      ],
    });
  });

  it("duplicate ids in the legacy flat speakerIds list collapse silently (no role ambiguity)", async () => {
    mockTx.sessionSpeaker.createMany.mockResolvedValue({ count: 1 });
    const res = await updateSession({ ...BASE_UPDATE, speakerIds: ["sp1", "sp1", "sp2"] });
    expect(res.ok).toBe(true);
    const data = mockTx.sessionSpeaker.createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(2);
  });

  it("duplicate speakerIds within one TOPIC's list are Set-deduped (TopicSpeaker PK)", async () => {
    mockTx.sessionTopic.findMany.mockResolvedValue([{ id: "t1" }]);
    mockTx.topicSpeaker.createMany.mockResolvedValue({ count: 1 });
    const res = await updateSession({
      ...BASE_UPDATE,
      topics: [{ id: "t1", title: "Topic A", speakerIds: ["sp1", "sp1", "sp2"] }],
    });
    expect(res.ok).toBe(true);
    expect(mockTx.topicSpeaker.createMany).toHaveBeenCalledWith({
      data: [
        { topicId: "t1", speakerId: "sp1" },
        { topicId: "t1", speakerId: "sp2" },
      ],
    });
  });
});
