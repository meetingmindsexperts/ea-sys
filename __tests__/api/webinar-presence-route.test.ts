/**
 * POST /api/public/events/[slug]/sessions/[sessionId]/presence — the webinar
 * lobby/live presence heartbeat. Pins: auth gate, org-staff skip (no write),
 * not-registered 403, create path, escalate lobby→joined (phase + joinCount),
 * and never-downgrade joined→lobby. Uses an `upsert` (no interactive
 * transaction) so two-tab first-beats can't collide on the unique key (no
 * P2002) and no pooled connection is held — see review finding #1.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockCheckRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCheckRateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds?: number } => ({ allowed: true })),
  mockDb: {
    event: { findFirst: vi.fn() },
    registration: { findFirst: vi.fn(), updateMany: vi.fn() },
    eventSession: { findFirst: vi.fn() },
    webinarPresence: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => mockCheckRateLimit(),
  getClientIp: () => "127.0.0.1",
}));

import { POST } from "@/app/api/public/events/[slug]/sessions/[sessionId]/presence/route";
import { resetRoomOpenCache } from "@/lib/webinar/viewer-entitlement";

function call(body: unknown) {
  // headers present so publicEventWhere can read Host (absent → unscoped where)
  const req = { json: async () => body, headers: new Headers() } as unknown as Request;
  return POST(req, { params: Promise.resolve({ slug: "evt", sessionId: "sess1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRoomOpenCache();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.eventSession.findFirst.mockResolvedValue({ id: "sess1" });
  mockDb.registration.findFirst.mockResolvedValue({ id: "reg1" });
  mockDb.webinarPresence.findUnique.mockResolvedValue(null);
  mockDb.webinarPresence.upsert.mockResolvedValue({});
});

describe("presence heartbeat", () => {
  it("401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(401);
  });

  it("org staff are skipped (tracked:false, no write)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tracked: false });
    expect(mockDb.webinarPresence.upsert).not.toHaveBeenCalled();
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("403 when the user is not a registrant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(403);
  });

  it("upserts a presence row on first beat + sets webinarFirstJoinedAt", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.webinarPresence.findUnique.mockResolvedValue(null);
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(200);
    expect(mockDb.webinarPresence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sessionId: "sess1", registrationId: "reg1", phase: "lobby", joinCount: 1 }),
      }),
    );
    // First beat (no existing row) → set the durable Joined marker.
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", webinarFirstJoinedAt: null } }),
    );
  });

  it("escalates lobby→joined: update sets phase, and admission is the row's first join (no extra count), skips the marker write", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "lobby", lastSeenAt: new Date(Date.now() - 30_000) });
    await call({ phase: "joined" });
    const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
    expect(arg.update).toEqual(expect.objectContaining({ phase: "joined" }));
    // Review of 0b3f34ad: the first beat is nearly always a lobby one, so counting admission made one viewing read as 2.
    expect(arg.update.joinCount).toBeUndefined();
    // Existing row → no redundant marker write.
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("never downgrades joined→lobby (update touches lastSeenAt only)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 30_000) });
    await call({ phase: "lobby" });
    const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
    expect(arg.update.phase).toBeUndefined();
    expect(arg.update.joinCount).toBeUndefined();
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });

  describe("minutes watched and returns (Nov 16, 2026; presence-watch.ts)", () => {
    const webinarEvent = (status: string) => ({
      id: "ev1",
      organizationId: "org1",
      eventType: "WEBINAR",
      status,
      settings: { webinar: { sessionId: "sess1" } },
    });

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
      mockDb.event.findFirst.mockResolvedValue(webinarEvent("PUBLISHED"));
      // The URL's session check, then the room rule's anchor read.
      mockDb.eventSession.findFirst.mockResolvedValue({ id: "sess1", status: "LIVE" });
    });

    it("a live-view beat 30 s after the last, room open: adds 30 seconds, no extra join", async () => {
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 30_000) });
      await call({ phase: "joined" });
      const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
      expect(arg.update.watchedSeconds).toEqual({ increment: 30 });
      expect(arg.update.joinCount).toBeUndefined();
    });

    it("room closed: nothing is added", async () => {
      mockDb.eventSession.findFirst.mockResolvedValue({ id: "sess1", status: "COMPLETED" });
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 30_000) });
      await call({ phase: "joined" });
      expect(mockDb.webinarPresence.upsert.mock.calls[0][0].update.watchedSeconds).toBeUndefined();
    });

    it("a DRAFT event's room counts as open, as it does for the attendee page (review of 0b3f34ad)", async () => {
      mockDb.event.findFirst.mockResolvedValue(webinarEvent("DRAFT"));
      mockDb.eventSession.findFirst.mockResolvedValue({ id: "sess1", status: "SCHEDULED" });
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 30_000) });
      await call({ phase: "joined" });
      expect(mockDb.webinarPresence.upsert.mock.calls[0][0].update.watchedSeconds).toEqual({ increment: 30 });
    });

    it("a lobby beat never asks whether the room is open (the heartbeat gains no query)", async () => {
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 30_000) });
      await call({ phase: "lobby" });
      // Only the URL's own session check ran.
      expect(mockDb.eventSession.findFirst).toHaveBeenCalledTimes(1);
    });

    it("back after fifteen minutes away: one more join, and the absence is not counted as watched", async () => {
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 15 * 60_000) });
      await call({ phase: "joined" });
      const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
      expect(arg.update.joinCount).toEqual({ increment: 1 });
      expect(arg.update.watchedSeconds).toBeUndefined();
    });

    it("the page reopened after fifteen minutes: its first beat is a lobby one, and it still counts the return (review of d2200512)", async () => {
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 15 * 60_000) });
      await call({ phase: "lobby" });
      const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
      expect(arg.update.joinCount).toEqual({ increment: 1 });
      // Never demoted, and the next live-view beat (short gap now) adds time, not another join.
      expect(arg.update.phase).toBeUndefined();
    });

    it("back the next day with the room closed (the replay): not a join", async () => {
      mockDb.eventSession.findFirst.mockResolvedValue({ id: "sess1", status: "COMPLETED" });
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 24 * 3600_000) });
      await call({ phase: "lobby" });
      expect(mockDb.webinarPresence.upsert.mock.calls[0][0].update.joinCount).toBeUndefined();
    });

    it("five minutes in a hidden tab is not a return", async () => {
      mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined", lastSeenAt: new Date(Date.now() - 5 * 60_000) });
      await call({ phase: "joined" });
      expect(mockDb.webinarPresence.upsert.mock.calls[0][0].update.joinCount).toBeUndefined();
    });
  });
});
