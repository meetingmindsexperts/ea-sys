/**
 * /api/admin/backups: operator-only listing of the DR bucket and a presigned
 * download of ONE database dump. Pins the boundary (401 / 403 for an ADMIN
 * who is not the platform operator), the key guard (only db/ dumps, refused
 * before any AWS call), the audit row every download writes, and the rate
 * limit on downloads.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockRateLimit, mockList, mockHealth, mockPresign, mockRecordExport, logs } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(),
  mockList: vi.fn(),
  mockHealth: vi.fn(),
  mockPresign: vi.fn(),
  mockRecordExport: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b, headers: { set: () => {} } }),
  },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logs }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: () => mockRateLimit() }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: (...a: unknown[]) => mockRecordExport(...a) }));
vi.mock("@/lib/infra/aws-ops", async () => {
  const actual = await vi.importActual<typeof import("@/lib/infra/aws-ops")>("@/lib/infra/aws-ops");
  return {
    ...actual,
    listDrBackups: (...a: unknown[]) => mockList(...a),
    fetchDr: (...a: unknown[]) => mockHealth(...a),
    presignDrBackupDownload: (...a: unknown[]) => mockPresign(...a),
  };
});
// aws-ops imports these at module load; keep them inert.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/worker-jobs", () => ({ EXPECTED_JOBS: [] }));
vi.mock("@/lib/build-info", () => ({ getBuildInfo: () => ({}) }));
vi.mock("@/lib/admin-alert", () => ({ getAlertSilence: vi.fn() }));
// Real operator predicate: on master (no PLATFORM_ORG_ID) it reduces to SUPER_ADMIN.
vi.mock("@/lib/platform-operator", async () => await vi.importActual("@/lib/platform-operator"));

import { GET, POST } from "@/app/api/admin/backups/route";

const SUPER = { user: { id: "u1", role: "SUPER_ADMIN", organizationId: "org1" } };
const ADMIN = { user: { id: "u2", role: "ADMIN", organizationId: "org1" } };

const postReq = (body: unknown) =>
  ({ nextUrl: new URL("http://localhost/api/admin/backups"), json: async () => body, headers: new Headers() }) as never;

const listingFor = (prefix: string) => ({
  status: "ok",
  bucket: "ea-sys-dr-singapore",
  prefix,
  windowHours: 72,
  objects: [],
  totalObjects: 0,
  truncated: false,
});
const HEALTH = { status: "ok", rows: [] };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ORG_ID;
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockList.mockImplementation(async (kind: string) => listingFor(`${kind}/`));
  mockHealth.mockResolvedValue(HEALTH);
  mockPresign.mockResolvedValue("https://signed.example/dump");
});

describe("GET /api/admin/backups", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("403 for an ADMIN (not the platform operator on master)", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    expect((await GET()).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns the three streams' last 72h plus their freshness for a SUPER_ADMIN, in one call", async () => {
    mockAuth.mockResolvedValue(SUPER);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("db");
    expect(mockList).toHaveBeenCalledWith("uploads");
    expect(mockList).toHaveBeenCalledWith("env");
    expect(mockHealth).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toEqual({
      bucket: "ea-sys-dr-singapore",
      windowHours: 72,
      health: HEALTH,
      db: listingFor("db/"),
      uploads: listingFor("uploads/"),
      env: listingFor("env/"),
    });
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ windowHours: 72 }), "admin-backups:listed");
  });

  it("reports a failed stream inside its own block and still returns the others", async () => {
    mockAuth.mockResolvedValue(SUPER);
    mockList.mockImplementation(async (kind: string) =>
      kind === "uploads" ? { ...listingFor("uploads/"), status: "error", error: "AccessDenied" } : listingFor(`${kind}/`),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uploads.status).toBe("error");
    expect(body.db.status).toBe("ok");
  });
});

describe("POST /api/admin/backups (download link)", () => {
  it("403 for an ADMIN, before any key check", async () => {
    mockAuth.mockResolvedValue(ADMIN);
    expect((await POST(postReq({ key: "db/2026/09/10-05-mumbai.dump" }))).status).toBe(403);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a dump or a mirror archive, before any AWS call and with no audit row", async () => {
    mockAuth.mockResolvedValue(SUPER);
    for (const key of ["env/2026-09-10.env", "db/../env/x", "mirror-archives/../db/x.dump", "uploads/media/x.jpg", "", 42, undefined]) {
      const res = await POST(postReq({ key }));
      expect(res.status, String(key)).toBe(400);
      expect((await res.json()).code).toBe("INVALID_KEY");
    }
    expect(mockPresign).not.toHaveBeenCalled();
    expect(mockRecordExport).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }), "admin-backups:download-refused");
  });

  it("presigns a dump and records the export under the operator's name", async () => {
    mockAuth.mockResolvedValue(SUPER);
    const res = await POST(postReq({ key: "db/2026/09/10-05-mumbai.dump" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://signed.example/dump", key: "db/2026/09/10-05-mumbai.dump", expiresInSeconds: 300 });
    expect(mockPresign).toHaveBeenCalledWith("db/2026/09/10-05-mumbai.dump");
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "DatabaseBackup",
        organizationId: "org1",
        userId: "u1",
        role: "SUPER_ADMIN",
        format: "pg_dump",
        rowCount: 1,
        filters: { key: "db/2026/09/10-05-mumbai.dump" },
      }),
    );
    expect(logs.info).toHaveBeenCalledWith(expect.objectContaining({ key: "db/2026/09/10-05-mumbai.dump" }), "admin-backups:download-presigned");
  });

  it("presigns a finished mirror archive and records it as a MirrorArchive zip export", async () => {
    mockAuth.mockResolvedValue(SUPER);
    const res = await POST(postReq({ key: "mirror-archives/2026-09-11-req1.zip" }));
    expect(res.status).toBe(200);
    expect(mockPresign).toHaveBeenCalledWith("mirror-archives/2026-09-11-req1.zip");
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: "MirrorArchive", format: "zip", filters: { key: "mirror-archives/2026-09-11-req1.zip" } }),
    );
  });

  it("429 when the download budget is spent, with no link minted", async () => {
    mockAuth.mockResolvedValue(SUPER);
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    const res = await POST(postReq({ key: "db/2026/09/10-05-mumbai.dump" }));
    expect(res.status).toBe(429);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it("502 when the presigner fails, logged at error", async () => {
    mockAuth.mockResolvedValue(SUPER);
    mockPresign.mockRejectedValue(new Error("boom"));
    const res = await POST(postReq({ key: "db/2026/09/10-05-mumbai.dump" }));
    expect(res.status).toBe(502);
    expect(logs.error).toHaveBeenCalledWith(expect.objectContaining({ key: "db/2026/09/10-05-mumbai.dump" }), "admin-backups:presign-failed");
    expect(mockRecordExport).not.toHaveBeenCalled();
  });
});
