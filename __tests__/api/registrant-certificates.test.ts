/**
 * A person's own certificates on /my-registration (Nov 4, 2026).
 *
 * The load-bearing rule is `releasedCertificatesWhere`: the list and the
 * download both ask it, so a certificate that is not theirs, revoked, or still
 * sitting in a run the organiser has not sent is invisible AND undownloadable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockLoad, mockRateLimit, logger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: { issuedCertificate: { findFirst: vi.fn() } },
  mockLoad: vi.fn(),
  mockRateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/tenant/resolver", () => ({ resolveRequestOrgId: vi.fn(async () => null) }));
vi.mock("@/lib/tenant-lane", () => ({ runWithTenantLane: (_o: unknown, _c: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/certificates/pdf-loader", () => ({ loadCertificatePdfBytes: mockLoad }));
vi.mock("@/lib/security", () => ({ checkRateLimit: mockRateLimit }));

import { GET } from "@/app/api/registrant/certificates/[certificateId]/download/route";
import { releasedCertificatesWhere } from "@/lib/registrant-certificates";

function get(certificateId = "cert1") {
  return GET(new Request("http://x"), { params: Promise.resolve({ certificateId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", email: "Anna@Example.com", role: "REGISTRANT" } });
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterSeconds: 0 });
  mockLoad.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
});

describe("releasedCertificatesWhere", () => {
  const where = releasedCertificatesWhere("u1", "anna@example.com");
  const [owner, released] = where.AND as [{ OR: unknown[] }, { OR: unknown[] }];

  it("never a revoked certificate or one with no PDF yet", () => {
    expect(where.revokedAt).toBeNull();
    expect(where.pdfUrl).toEqual({ not: null });
  });

  it("finds the person through their registrations and their speaker records, by account or email", () => {
    expect(owner.OR).toEqual([
      { registration: { OR: [{ userId: "u1" }, { attendee: { email: "anna@example.com" } }] } },
      { speaker: { OR: [{ userId: "u1" }, { email: "anna@example.com" }] } },
    ]);
  });

  it("a run's certificate only once it was emailed; a directly issued or resent one always", () => {
    expect(released.OR).toEqual([
      { issueRunItemId: null, issueRunItem: { is: null } },
      { deliveredViaItem: { emailedAt: { not: null } } },
      { issueRunItem: { emailedAt: { not: null } } },
      { lastResentAt: { not: null } },
    ]);
  });
});

describe("GET /api/registrant/certificates/[certificateId]/download", () => {
  it("refuses a signed-out request", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(mockDb.issuedCertificate.findFirst).not.toHaveBeenCalled();
  });

  it("looks the certificate up through the released rule, with the email lowercased", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
    await get("cert9");
    expect(mockDb.issuedCertificate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cert9", ...releasedCertificatesWhere("u1", "anna@example.com") } }),
    );
  });

  it("someone else's, unsent or revoked certificate is a logged 404 and no file is read", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining(":not-found"), certificateId: "cert1" }));
  });

  it("streams the person's own PDF as a private attachment named by serial", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert1", eventId: "ev1", serial: "MMF-ATT-007", pdfUrl: "/uploads/certificates/ev1/cert1.pdf" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Certificate-MMF-ATT-007.pdf"');
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockLoad).toHaveBeenCalledWith("/uploads/certificates/ev1/cert1.pdf", expect.objectContaining({ certificateId: "cert1", userId: "u1" }));
  });

  it("keeps the filename to safe characters", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "c", eventId: "e", serial: 'A"B\r\nC/..', pdfUrl: "/uploads/certificates/e/c.pdf" });
    const res = await get();
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Certificate-ABC...pdf"');
  });

  it("is rate limited per person", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 90 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 90, limit: 60, windowSeconds: 3600 });
    expect(mockDb.issuedCertificate.findFirst).not.toHaveBeenCalled();
  });

  it("a storage failure is a logged 500", async () => {
    mockDb.issuedCertificate.findFirst.mockResolvedValue({ id: "cert1", eventId: "ev1", serial: "S1", pdfUrl: "/uploads/certificates/ev1/cert1.pdf" });
    mockLoad.mockRejectedValue(new Error("gone"));
    expect((await get()).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining(":failed") }));
  });
});
