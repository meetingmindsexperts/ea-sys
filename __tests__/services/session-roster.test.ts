/**
 * Unit tests for session-service's roster operations (duplication-audit
 * findings 4+7 extraction): setSessionSpeakersTx (the ONE swap + L1 cleanup
 * applier shared by updateSession and replaceSessionRoster) and the
 * add/remove/replace service functions backing the MCP per-speaker tools.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockApiLogger } = vi.hoisted(() => {
  const tx = {
    sessionSpeaker: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    topicSpeaker: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  return {
    mockDb: {
      eventSession: { findFirst: vi.fn() },
      speaker: { findFirst: vi.fn(), findMany: vi.fn() },
      sessionSpeaker: { findUnique: vi.fn(), upsert: vi.fn() },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/event-stats", () => ({ refreshEventStats: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));

import {
  addSessionSpeaker,
  removeSessionSpeaker,
  replaceSessionRoster,
  setSessionSpeakersTx,
} from "@/services/session-service";

const BASE = { eventId: "ev1", sessionId: "s1", actorUserId: "u1", source: "mcp" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "SESSION" });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "sp1" });
  mockDb.sessionSpeaker.findUnique.mockResolvedValue(null);
  mockDb.sessionSpeaker.upsert.mockResolvedValue({ sessionId: "s1", speakerId: "sp1", role: "SPEAKER" });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb._tx.sessionSpeaker.deleteMany.mockResolvedValue({ count: 1 });
  mockDb._tx.sessionSpeaker.findMany.mockResolvedValue([]);
  mockDb._tx.topicSpeaker.deleteMany.mockResolvedValue({ count: 0 });
});

describe("setSessionSpeakersTx (the shared swap + L1 cleanup applier)", () => {
  it("deletes, recreates, and cleans dropped speakers off this session's topics", async () => {
    mockDb._tx.topicSpeaker.deleteMany.mockResolvedValue({ count: 2 });
    const res = await setSessionSpeakersTx(
      mockDb._tx as never,
      "s1",
      [{ speakerId: "sp1", role: "SPEAKER" }, { speakerId: "sp2", role: "MODERATOR" }],
    );
    expect(mockDb._tx.sessionSpeaker.deleteMany).toHaveBeenCalledWith({ where: { sessionId: "s1" } });
    expect(mockDb._tx.sessionSpeaker.createMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "s1", speakerId: "sp1", role: "SPEAKER" },
        { sessionId: "s1", speakerId: "sp2", role: "MODERATOR" },
      ],
    });
    // L1: everyone NOT in the new roster drops off the session's topics.
    expect(mockDb._tx.topicSpeaker.deleteMany).toHaveBeenCalledWith({
      where: { topic: { sessionId: "s1" }, speakerId: { notIn: ["sp1", "sp2"] } },
    });
    expect(res.topicRowsRemoved).toBe(2);
  });

  it("skips the L1 cleanup when the caller rewrites topics itself (updateSession step 3)", async () => {
    const res = await setSessionSpeakersTx(mockDb._tx as never, "s1", [], { cleanTopicSpeakers: false });
    expect(mockDb._tx.topicSpeaker.deleteMany).not.toHaveBeenCalled();
    expect(res.topicRowsRemoved).toBe(0);
    // Empty roster → no createMany, but the delete still ran (clear-all).
    expect(mockDb._tx.sessionSpeaker.createMany).not.toHaveBeenCalled();
    expect(mockDb._tx.sessionSpeaker.deleteMany).toHaveBeenCalled();
  });
});

describe("addSessionSpeaker", () => {
  it("creates the assignment, audits with source", async () => {
    const r = await addSessionSpeaker({ ...BASE, speakerId: "sp1", role: "SPEAKER" });
    expect(r).toMatchObject({ ok: true, alreadyAssigned: false, roleChanged: false });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CREATE",
        entityType: "SessionSpeaker",
        entityId: "s1:sp1",
        changes: expect.objectContaining({ source: "mcp", role: "SPEAKER" }),
      }),
    });
  });

  it("same role → idempotent no-op; different role → role update audited with previousRole", async () => {
    mockDb.sessionSpeaker.findUnique.mockResolvedValue({ role: "SPEAKER" });
    const noop = await addSessionSpeaker({ ...BASE, speakerId: "sp1", role: "SPEAKER" });
    expect(noop).toMatchObject({ ok: true, alreadyAssigned: true });
    expect(mockDb.sessionSpeaker.upsert).not.toHaveBeenCalled();

    mockDb.sessionSpeaker.upsert.mockResolvedValue({ sessionId: "s1", speakerId: "sp1", role: "MODERATOR" });
    const flip = await addSessionSpeaker({ ...BASE, speakerId: "sp1", role: "MODERATOR" });
    expect(flip).toMatchObject({ ok: true, alreadyAssigned: false, roleChanged: true });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UPDATE",
        changes: expect.objectContaining({ previousRole: "SPEAKER" }),
      }),
    });
  });

  it("H1: refuses a roster on a break item; SESSION_NOT_FOUND / SPEAKER_NOT_FOUND logged", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "BREAK" });
    expect(await addSessionSpeaker({ ...BASE, speakerId: "sp1", role: "SPEAKER" })).toMatchObject({
      ok: false,
      code: "BREAK_ITEM_HAS_PROGRAM",
    });
    mockDb.eventSession.findFirst.mockResolvedValue(null);
    expect(await addSessionSpeaker({ ...BASE, speakerId: "sp1", role: "SPEAKER" })).toMatchObject({
      ok: false,
      code: "SESSION_NOT_FOUND",
    });
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "SESSION" });
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect(await addSessionSpeaker({ ...BASE, speakerId: "spX", role: "SPEAKER" })).toMatchObject({
      ok: false,
      code: "SPEAKER_NOT_FOUND",
    });
    expect(mockApiLogger.warn).toHaveBeenCalledTimes(3);
  });
});

describe("removeSessionSpeaker", () => {
  it("removes + L1-cleans the per-topic rows in one transaction, audits", async () => {
    mockDb._tx.sessionSpeaker.deleteMany.mockResolvedValue({ count: 1 });
    mockDb._tx.topicSpeaker.deleteMany.mockResolvedValue({ count: 3 });
    const r = await removeSessionSpeaker({ ...BASE, speakerId: "sp1" });
    expect(r).toEqual({ ok: true, removed: true, topicRowsRemoved: 3 });
    expect(mockDb._tx.topicSpeaker.deleteMany).toHaveBeenCalledWith({
      where: { speakerId: "sp1", topic: { sessionId: "s1" } },
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "DELETE", changes: expect.objectContaining({ topicRowsRemoved: 3 }) }),
    });
  });

  it("not assigned → removed:false, no topic cleanup, no audit (idempotent)", async () => {
    mockDb._tx.sessionSpeaker.deleteMany.mockResolvedValue({ count: 0 });
    const r = await removeSessionSpeaker({ ...BASE, speakerId: "sp1" });
    expect(r).toEqual({ ok: true, removed: false, topicRowsRemoved: 0 });
    expect(mockDb._tx.topicSpeaker.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("NO break-item gate on remove — cleanup is always allowed", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "LUNCH" });
    const r = await removeSessionSpeaker({ ...BASE, speakerId: "sp1" });
    expect(r.ok).toBe(true);
  });
});

describe("replaceSessionRoster", () => {
  beforeEach(() => {
    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }, { id: "sp2" }]);
    mockDb._tx.sessionSpeaker.findMany.mockResolvedValue([{ speakerId: "old1", role: "SPEAKER" }]);
    mockDb._tx.topicSpeaker.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("atomic swap via the shared applier; returns before/after + topic cleanup count; audits", async () => {
    const r = await replaceSessionRoster({
      ...BASE,
      assignments: [{ speakerId: "sp1", role: "SPEAKER" }, { speakerId: "sp2", role: "PANELIST" }],
    });
    expect(r).toMatchObject({
      ok: true,
      before: [{ speakerId: "old1", role: "SPEAKER" }],
      topicRowsRemoved: 1,
    });
    expect(mockDb._tx.sessionSpeaker.createMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "s1", speakerId: "sp1", role: "SPEAKER" },
        { sessionId: "s1", speakerId: "sp2", role: "PANELIST" },
      ],
    });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "REPLACE", entityId: "s1" }),
    });
  });

  it("DUPLICATE_SPEAKER_ID before any lookup; SPEAKER_NOT_FOUND carries missingSpeakerIds meta", async () => {
    expect(
      await replaceSessionRoster({
        ...BASE,
        assignments: [{ speakerId: "sp1", role: "SPEAKER" }, { speakerId: "sp1", role: "MODERATOR" }],
      }),
    ).toMatchObject({ ok: false, code: "DUPLICATE_SPEAKER_ID" });

    mockDb.speaker.findMany.mockResolvedValue([{ id: "sp1" }]);
    const r = await replaceSessionRoster({
      ...BASE,
      assignments: [{ speakerId: "sp1", role: "SPEAKER" }, { speakerId: "spX", role: "SPEAKER" }],
    });
    expect(r).toMatchObject({ ok: false, code: "SPEAKER_NOT_FOUND", meta: { missingSpeakerIds: ["spX"] } });
  });

  it("H1: non-empty replacement on a break item refused; EMPTY replacement allowed (cleanup)", async () => {
    mockDb.eventSession.findFirst.mockResolvedValue({ id: "s1", type: "BREAK" });
    expect(
      await replaceSessionRoster({ ...BASE, assignments: [{ speakerId: "sp1", role: "SPEAKER" }] }),
    ).toMatchObject({ ok: false, code: "BREAK_ITEM_HAS_PROGRAM" });

    const empty = await replaceSessionRoster({ ...BASE, assignments: [] });
    expect(empty.ok).toBe(true);
    expect(mockDb._tx.sessionSpeaker.deleteMany).toHaveBeenCalled();
  });
});
