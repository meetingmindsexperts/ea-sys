/**
 * session-service — the extraction that closes the program/agenda review's
 * H1 (PUT destroyed child rows before checking the optimistic lock, and did so
 * non-transactionally) and H4 (no service: MCP create_session wrote no audit
 * row, sent no admin notification, and dropped status/abstractId/sortOrder;
 * capacity + zero-duration rules disagreed between REST and MCP).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockTx, mockApiLogger, mockNotify, mockRefreshStats } = vi.hoisted(() => {
  const mockTx = {
    eventSession: { updateMany: vi.fn() },
    sessionSpeaker: { deleteMany: vi.fn(), createMany: vi.fn() },
    sessionTopic: { deleteMany: vi.fn(), create: vi.fn() },
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
  });
  mockDb.auditLog.create.mockReturnValue({ catch: () => {} });
  mockNotify.mockReturnValue({ catch: () => {} });
  mockTx.eventSession.updateMany.mockResolvedValue({ count: 1 });
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
