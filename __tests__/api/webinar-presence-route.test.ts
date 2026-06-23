/**
 * POST /api/public/events/[slug]/sessions/[sessionId]/presence — the webinar
 * lobby/live presence heartbeat. Pins: auth gate, org-staff skip (no write),
 * not-registered 403, create path, escalate lobby→joined (phase + joinCount),
 * and never-downgrade joined→lobby.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockCheckRateLimit, txMock } = vi.hoisted(() => {
  const txMock = {
    webinarPresence: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    registration: { updateMany: vi.fn() },
  };
  return {
    txMock,
    mockAuth: vi.fn(),
    mockCheckRateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds?: number } => ({ allowed: true })),
    mockDb: {
      event: { findFirst: vi.fn() },
      registration: { findFirst: vi.fn() },
      eventSession: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) => fn(txMock)),
    },
  };
});

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
  txMock.webinarPresence.findUnique.mockResolvedValue(null);
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
    expect(txMock.webinarPresence.create).not.toHaveBeenCalled();
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });

  it("403 when the user is not a registrant", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    mockDb.registration.findFirst.mockResolvedValue(null);
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(403);
  });

  it("creates a presence row on first beat + sets webinarFirstJoinedAt", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    txMock.webinarPresence.findUnique.mockResolvedValue(null);
    const res = await call({ phase: "lobby" });
    expect(res.status).toBe(200);
    expect(txMock.webinarPresence.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sessionId: "sess1", registrationId: "reg1", phase: "lobby", joinCount: 1 }) }),
    );
    expect(txMock.registration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "reg1", webinarFirstJoinedAt: null } }),
    );
  });

  it("escalates lobby→joined: sets phase + bumps joinCount", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    txMock.webinarPresence.findUnique.mockResolvedValue({ id: "p1", phase: "lobby" });
    await call({ phase: "joined" });
    expect(txMock.webinarPresence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p1" },
        data: expect.objectContaining({ phase: "joined", joinCount: { increment: 1 } }),
      }),
    );
  });

  it("never downgrades joined→lobby (updates lastSeenAt only)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", role: "REGISTRANT", organizationId: null } });
    txMock.webinarPresence.findUnique.mockResolvedValue({ id: "p1", phase: "joined" });
    await call({ phase: "lobby" });
    const arg = txMock.webinarPresence.update.mock.calls[0][0];
    expect(arg.data.phase).toBeUndefined();
    expect(arg.data.joinCount).toBeUndefined();
    expect(arg.data.lastSeenAt).toBeInstanceOf(Date);
  });
});
