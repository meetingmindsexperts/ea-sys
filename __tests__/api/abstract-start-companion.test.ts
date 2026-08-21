/**
 * The abstract-start SIGN-IN door (review M9 — this route had ZERO tests):
 * despite its name it serves BOTH the abstract and session-proposal register
 * pages' existing-account paths, and it carries the same policy as the full
 * signup door:
 *   - PROPOSAL sign-ins are linkOnly (owner decision Aug 5, 2026 — no auto
 *     comp registration); ABSTRACT sign-ins still auto-mint.
 *   - A freshly-created speaker starts INVITED (both sources).
 *   - An EXISTING speaker's status is never touched (inheritance).
 * A refactor of this route must not silently reintroduce auto-comp for
 * proposers — that's exactly what this file pins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, ensureCompanionSpy, upsertSpy, rateLimitSpy, compareSpy } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    // Written by the shared public-credential guard (review M7).
    loginEvent: { create: vi.fn() },
    registration: { findFirst: vi.fn() },
  },
  ensureCompanionSpy: vi.fn(),
  upsertSpy: vi.fn(),
  rateLimitSpy: vi.fn(),
  compareSpy: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number; headers?: Record<string, string> }) => ({
      status: i?.status ?? 200,
      json: async () => b,
      headers: { get: (k: string) => i?.headers?.[k] ?? null, set: () => {} },
    }),
  },
}));
vi.mock("bcryptjs", () => ({ default: { compare: (...a: unknown[]) => compareSpy(...a) } }));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (cb: (t: unknown) => unknown) =>
    cb({ user: { update: vi.fn() } }),
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, cb: () => unknown) => cb(),
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // The shared public-credential guard logs through authLogger.
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/public-event", () => ({
  publicEventWhere: async () => ({ slug: "ev-slug" }),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (...a: unknown[]) => rateLimitSpy(...a),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/speaker-companion", () => ({
  ensureSpeakerCompanionRegistration: ensureCompanionSpy,
  upsertEventSpeaker: upsertSpy,
}));

import { POST } from "@/app/api/public/events/[slug]/abstract-start/route";

const params = { params: Promise.resolve({ slug: "ev-slug" }) };
const makeReq = (body: Record<string, unknown>) =>
  new Request("http://test/api/public/events/ev-slug/abstract-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const validBody = { email: "jane@example.com", password: "secret123" };

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitSpy.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  compareSpy.mockResolvedValue(true);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.user.findFirst.mockResolvedValue({
    id: "u1",
    role: "SUBMITTER",
    passwordHash: "hash",
    firstName: "Jane",
    lastName: "Doe",
    termsAcceptedAt: new Date("2026-01-01"),
  });
  mockDb.registration.findFirst.mockResolvedValue(null);
  upsertSpy.mockResolvedValue("sp1");
  ensureCompanionSpy.mockResolvedValue({ status: "created", registrationId: "reg1" });
});

describe("abstract-start — companion policy per source", () => {
  it("an ABSTRACT sign-in still auto-mints (linkOnly false)", async () => {
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(200);
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    // The decision, not the option object (see the submitter suite).
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).not.toBe(true);
  });

  it("a PROPOSAL sign-in is linkOnly — NO auto comp registration (owner decision Aug 5, 2026)", async () => {
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(res.status).toBe(200);
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).toBe(true);
  });

  it("a companion failure never fails the sign-in (failure-isolated)", async () => {
    ensureCompanionSpy.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(res.status).toBe(200);
  });
});

describe("abstract-start — speaker status + source stamping", () => {
  it("creates fresh speakers as INVITED for BOTH sources (team confirms after review)", async () => {
    for (const source of ["abstract", "proposal"] as const) {
      upsertSpy.mockClear();
      await POST(makeReq({ ...validBody, source }), params);
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          profile: expect.objectContaining({ status: "INVITED", submitterSource: source }),
        }),
      );
    }
  });

  it("sign-in NEVER clobbers an existing profile (overwriteExisting: false — status inheritance lives in the upsert)", async () => {
    await POST(makeReq({ ...validBody, source: "proposal" }), params);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ overwriteExisting: false }),
    );
  });
});

describe("abstract-start — guards", () => {
  it("401 on a wrong password, and the companion path never runs", async () => {
    compareSpy.mockResolvedValue(false);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(401);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  // Review M7 — this door checks a password on the unauthenticated surface.
  it("a wrong password is RECORDED, so a spray here shows up in Sign-in Activity", async () => {
    compareSpy.mockResolvedValue(false);
    await POST(makeReq(validBody), params);
    expect(mockDb.loginEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "FAILED_PASSWORD", userId: "u1", surface: "EVENT_PAGE" }),
      }),
    );
  });

  it("an unknown address is recorded as FAILED_UNKNOWN_EMAIL — spray, not targeting", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(401);
    expect(mockDb.loginEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: "FAILED_UNKNOWN_EMAIL", userId: null }),
      }),
    );
  });

  it("a SUCCESS here is NOT recorded — the client hands off to signIn(), which records it", async () => {
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(200);
    // A second row would double every successful sign-in in Sign-in Activity.
    expect(mockDb.loginEvent.create).not.toHaveBeenCalled();
  });

  it("429 when rate-limited (per email)", async () => {
    rateLimitSpy.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(429);
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
  });

  it("404 when the event doesn't resolve for this host/slug", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await POST(makeReq(validBody), params);
    expect(res.status).toBe(404);
  });
});
