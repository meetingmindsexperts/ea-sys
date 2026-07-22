/**
 * Unit tests for GET /api/events/[eventId]/certificates/runs/[runId]/download
 * — the per-run "Download all certificates" ZIP export. Covers auth guards,
 * org binding, the not-yet-rendered / nothing-rendered 409s, the size caps,
 * per-PDF failure isolation, and the happy path (real jszip round-trip:
 * the response body is unzipped and its entries asserted).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";

const { mockAuth, mockDb, mockCheckRateLimit, mockCollect, mockLoadPdf } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    certificateIssueRun: { findFirst: vi.fn() },
    certificateIssueRunItem: { findMany: vi.fn() },
  },
  mockCheckRateLimit: vi.fn<(args: unknown) => { allowed: boolean; retryAfterSeconds?: number }>(
    () => ({ allowed: true }),
  ),
  mockCollect: vi.fn(),
  mockLoadPdf: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (args: unknown) => mockCheckRateLimit(args),
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    const restricted = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE", "CRM_USER"];
    if (role && restricted.includes(role)) {
      return { status: 403, json: async () => ({ error: "Forbidden" }) };
    }
    return null;
  },
}));
vi.mock("@/lib/certificates/bundle", () => ({
  collectRunItemCertRows: (args: unknown) => mockCollect(args),
}));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: (url: string, ctx: unknown) => mockLoadPdf(url, ctx),
}));

import { GET } from "@/app/api/events/[eventId]/certificates/runs/[runId]/download/route";

const PARAMS = { params: Promise.resolve({ eventId: "evt-1", runId: "run-12345678abc" }) };
const REQ = new Request("http://localhost/api/x");
const SESSION = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const RUN = {
  id: "run-12345678abc",
  status: "AWAITING_REVIEW",
  templateIds: ["tpl-a"],
  certificateTemplateId: null,
  event: { code: "OSH" },
};

function certRow(serial: string) {
  return {
    pdfUrl: `/uploads/certificates/evt-1/${serial}.pdf`,
    serial,
    type: "ATTENDANCE",
    certificateTemplate: { name: "Attendance" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(SESSION);
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockDb.certificateIssueRun.findFirst.mockResolvedValue(RUN);
  mockDb.certificateIssueRunItem.findMany.mockResolvedValue([
    { registrationId: "reg-1", speakerId: null, templateIds: ["tpl-a"], issuedCertificateId: null, recipientName: "Dr. Jane Doe" },
    { registrationId: "reg-2", speakerId: null, templateIds: ["tpl-a"], issuedCertificateId: null, recipientName: "Mr. Bob Roe" },
  ]);
  mockCollect
    .mockResolvedValueOnce([certRow("OMM-ATT-0001")])
    .mockResolvedValueOnce([certRow("OMM-ATT-0002")]);
  mockLoadPdf.mockImplementation((url: string) => Promise.resolve(Buffer.from(`%PDF ${url}`)));
});

describe("GET /certificates/runs/[runId]/download", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(401);
  });

  it("404 when the run doesn't exist (or is cross-tenant — the lookup is org-bound)", async () => {
    mockDb.certificateIssueRun.findFirst.mockResolvedValue(null);
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(404);
    const where = mockDb.certificateIssueRun.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ eventId: "evt-1", event: { organizationId: "org-1" } });
  });

  it("429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("409 NOT_RENDERED while the run is still rendering", async () => {
    mockDb.certificateIssueRun.findFirst.mockResolvedValue({ ...RUN, status: "RENDERING" });
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NOT_RENDERED" });
  });

  it("409 NO_RENDERED_CERTS when no item yields a rendered PDF", async () => {
    mockCollect.mockReset();
    mockCollect.mockResolvedValue([]);
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "NO_RENDERED_CERTS" });
  });

  it("400 EXPORT_TOO_LARGE over the cert count cap", async () => {
    mockCollect.mockReset();
    mockCollect.mockResolvedValue(
      Array.from({ length: 251 }, (_, i) => certRow(`S-${i}`)),
    );
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });

  it("happy path: streams a zip whose entries are '{serial} - {name}.pdf'", async () => {
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain('filename="certificates-OSH-run-1234.zip"');

    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["OMM-ATT-0001 - Dr. Jane Doe.pdf", "OMM-ATT-0002 - Mr. Bob Roe.pdf"]);
    const first = await zip.files[names[0]].async("string");
    expect(first).toContain("%PDF /uploads/certificates/evt-1/OMM-ATT-0001.pdf");
  });

  it("skips un-rendered (pdfUrl-null) cert rows instead of failing", async () => {
    mockCollect.mockReset();
    mockCollect
      .mockResolvedValueOnce([{ ...certRow("OMM-ATT-0001"), pdfUrl: null }])
      .mockResolvedValueOnce([certRow("OMM-ATT-0002")]);
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(["OMM-ATT-0002 - Mr. Bob Roe.pdf"]);
  });

  it("one unreadable PDF doesn't sink the export (failure isolation)", async () => {
    mockLoadPdf
      .mockRejectedValueOnce(new Error("disk gone"))
      .mockResolvedValueOnce(Buffer.from("%PDF ok"));
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(["OMM-ATT-0002 - Mr. Bob Roe.pdf"]);
  });

  it("500 when EVERY PDF fails to load", async () => {
    mockLoadPdf.mockRejectedValue(new Error("disk gone"));
    const res = await GET(REQ, PARAMS);
    expect(res.status).toBe(500);
  });
});
