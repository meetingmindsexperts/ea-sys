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

function call(body: unknown) {
  const req = { json: async () => body } as unknown as Request;
  return POST(req, { params: Promise.resolve({ slug: "evt", sessionId: "sess1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it("escalates lobby→joined: update sets phase + bumps joinCount, skips the marker write", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "lobby" });
    await call({ phase: "joined" });
    const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
    expect(arg.update).toEqual(expect.objectContaining({ phase: "joined", joinCount: { increment: 1 } }));
    // Existing row → no redundant marker write.
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("never downgrades joined→lobby (update touches lastSeenAt only)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.webinarPresence.findUnique.mockResolvedValue({ phase: "joined" });
    await call({ phase: "lobby" });
    const arg = mockDb.webinarPresence.upsert.mock.calls[0][0];
    expect(arg.update.phase).toBeUndefined();
    expect(arg.update.joinCount).toBeUndefined();
    expect(arg.update.lastSeenAt).toBeInstanceOf(Date);
  });
});
