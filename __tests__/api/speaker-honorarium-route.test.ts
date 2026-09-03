/**
 * GET/PATCH /api/events/[eventId]/speakers/[speakerId]/honorarium — the
 * organiser-set honorarium / speaker fee (Sep 3, 2026).
 *
 *   - staff-only through the REAL denyReviewer: MEMBER / ONSITE / WEBINARS /
 *     REVIEWER / SUBMITTER are refused; ADMIN + ORGANIZER pass
 *   - the write binds { id, eventId } (never id alone); amount 0 clears BOTH
 *     columns; the audit row carries before → after
 *   - GET reads through readHonorarium: an unsupported currency reads as unset
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("next/server", () => {
  class MockNextResponse {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return { status: init?.status ?? 200, json: async () => body };
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "10.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/tenant-context", () => ({
  runWithTenant: (_org: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: vi.fn(() => ({ id: "evt1" })),
}));

import { GET, PATCH } from "@/app/api/events/[eventId]/speakers/[speakerId]/honorarium/route";

const params = () =>
  ({ params: Promise.resolve({ eventId: "evt1", speakerId: "spk1" }) }) as never;
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = (body?: unknown) => ({ json: async () => body, headers: new Map() }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockDb.event.findFirst.mockResolvedValue({ id: "evt1", organizationId: "org1" });
  mockDb.speaker.findFirst.mockResolvedValue({ id: "spk1", honorariumAmount: null, honorariumCurrency: null });
  mockDb.speaker.updateMany.mockResolvedValue({ count: 1 });
});

describe("access: the reimbursement boundary, not the speaker PUT's", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(401);
    expect((await PATCH(req({ amount: 1, currency: "USD" }), params())).status).toBe(401);
  });

  it.each(["MEMBER", "ONSITE", "WEBINARS", "REVIEWER", "SUBMITTER", "REGISTRANT"])(
    "%s is refused on both verbs and nothing is written",
    async (role) => {
      mockAuth.mockResolvedValue(session(role));
      expect((await GET(req(), params())).status).toBe(403);
      expect((await PATCH(req({ amount: 100, currency: "USD" }), params())).status).toBe(403);
      expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "ORGANIZER", "SUPER_ADMIN"])("%s may read and write", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), params())).status).toBe(200);
    expect((await PATCH(req({ amount: 100, currency: "USD" }), params())).status).toBe(200);
  });

  it("429 when the per-user bucket is spent", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await PATCH(req({ amount: 100, currency: "USD" }), params());
    expect(res.status).toBe(429);
    expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("rejects a negative amount and a currency the form cannot pay in", async () => {
    expect((await PATCH(req({ amount: -5, currency: "USD" }), params())).status).toBe(400);
    expect((await PATCH(req({ amount: 100, currency: "EUR" }), params())).status).toBe(400);
    expect((await PATCH(req(null), params())).status).toBe(400);
    expect(mockDb.speaker.updateMany).not.toHaveBeenCalled();
  });

  it("404 when the event is not reachable by the caller", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await PATCH(req({ amount: 100, currency: "USD" }), params())).status).toBe(404);
  });

  it("sets the fee with the write bound to { id, eventId } and audits before → after", async () => {
    const res = await PATCH(req({ amount: 1234.5, currency: "AED" }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ honorarium: { amount: 1234.5, currency: "AED" } });

    const call = mockDb.speaker.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "spk1", eventId: "evt1" });
    expect(call.data).toEqual({ honorariumAmount: 1234.5, honorariumCurrency: "AED" });

    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("HONORARIUM_SET");
    expect(audit.entityType).toBe("Speaker");
    expect(audit.entityId).toBe("spk1");
    expect(audit.userId).toBe("u1");
    expect(audit.changes.before).toBeNull();
    expect(audit.changes.after).toEqual({ amount: 1234.5, currency: "AED" });
  });

  it("amount 0 clears BOTH columns (a currency without an amount is not a state)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "spk1",
      honorariumAmount: "1500.00",
      honorariumCurrency: "USD",
    });
    const res = await PATCH(req({ amount: 0, currency: "USD" }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ honorarium: null });
    expect(mockDb.speaker.updateMany.mock.calls[0][0].data).toEqual({
      honorariumAmount: null,
      honorariumCurrency: null,
    });
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.changes.before).toEqual({ amount: 1500, currency: "USD" });
    expect(audit.changes.after).toBeNull();
  });

  it("404 (and no audit) when the bound write matches nothing", async () => {
    mockDb.speaker.updateMany.mockResolvedValue({ count: 0 });
    expect((await PATCH(req({ amount: 100, currency: "USD" }), params())).status).toBe(404);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("reads the fee through readHonorarium (Decimal serialised as a string)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "spk1",
      honorariumAmount: "1500.00",
      honorariumCurrency: "USD",
    });
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ honorarium: { amount: 1500, currency: "USD" } });
  });

  it("an unsupported currency reads as not set, never as a figure the form cannot pay", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({
      id: "spk1",
      honorariumAmount: "100.00",
      honorariumCurrency: "EUR",
    });
    expect(await (await GET(req(), params())).json()).toEqual({ honorarium: null });
  });

  it("404 for a speaker outside the event", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
    expect(mockDb.speaker.findFirst.mock.calls[0][0].where).toEqual({ id: "spk1", eventId: "evt1" });
  });
});
