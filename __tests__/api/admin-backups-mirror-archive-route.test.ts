/**
 * /api/admin/backups/mirror-archive: the queue behind "Build archive". Pins
 * the operator boundary, the one-at-a-time rule (409 while one is queued or
 * running), the requester snapshot on the row, and the rate limit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockRateLimit, dbm, logs } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  dbm: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: { mirrorArchive: dbm } }));
vi.mock("@/lib/logger", () => ({ apiLogger: logs }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => mockRateLimit() }));
vi.mock("@/lib/infra/mirror-archive-worker", () => ({ MIRROR_ARCHIVE_TTL_DAYS: 7 }));
vi.mock("@/lib/platform-operator", async () => await vi.importActual("@/lib/platform-operator"));

import { GET, POST } from "@/app/api/admin/backups/mirror-archive/route";

const SUPER = { user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org1", email: "kr@x.test" } };
const ADMIN = { user: { id: "u2", role: "ADMIN", organizationId: "org1" } };
const req = () => new Request("http://localhost/api/admin/backups/mirror-archive", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ORG_ID;
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  dbm.findMany.mockResolvedValue([]);
  dbm.findFirst.mockResolvedValue(null);
  dbm.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "new1", status: "PENDING", ...args.data }));
});

describe("GET", () => {
  it("401 / 403 outside the operator boundary", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockAuth.mockResolvedValue(ADMIN);
    expect((await GET()).status).toBe(403);
    expect(dbm.findMany).not.toHaveBeenCalled();
  });

  it("returns the recent rows, the active one and the TTL", async () => {
    mockAuth.mockResolvedValue(SUPER);
    dbm.findMany.mockResolvedValue([{ id: "a" }]);
    dbm.findFirst.mockResolvedValue({ id: "a", status: "RUNNING" });
    const body = await (await GET()).json();
    expect(body).toEqual({ archives: [{ id: "a" }], active: { id: "a", status: "RUNNING" }, ttlDays: 7 });
  });
});

describe("POST", () => {
  it("403 for an ADMIN, before any row is written", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    expect((await POST(req())).status).toBe(403);
    expect(dbm.create).not.toHaveBeenCalled();
  });

  it("creates a PENDING request with the requester snapshot", async () => {
    mockAuth.mockResolvedValue(SUPER);
    const res = await POST(req());
    expect(res.status).toBe(201);
    expect(dbm.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { requestedById: "u1", requestedByEmail: "kr@x.test" } }),
    );
    expect((await res.json()).archive.status).toBe("PENDING");
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", id: "new1" }), "admin-backups:archive-requested");
  });

  it("409 while an archive is queued or running, with the active row", async () => {
    mockAuth.mockResolvedValue(SUPER);
    dbm.findFirst.mockResolvedValue({ id: "busy", status: "RUNNING" });
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ARCHIVE_IN_PROGRESS");
    expect(body.active.id).toBe("busy");
    expect(dbm.create).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ activeId: "busy" }), "admin-backups:archive-already-active");
  });

  it("429 when the request budget is spent", async () => {
    mockAuth.mockResolvedValue(SUPER);
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 600 });
    expect((await POST(req())).status).toBe(429);
    expect(dbm.create).not.toHaveBeenCalled();
  });
});
