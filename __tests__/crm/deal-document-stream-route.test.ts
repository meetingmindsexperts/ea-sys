/**
 * Deal-document privacy (multi-tenant prep, July 23 2026).
 *
 * Deal files (prospectus, generated QUOTE PDFs, contract drafts) are PRIVATE:
 * blocked on the public /uploads catch-all, streamed only through the authed
 * GET /api/crm/deals/[dealId]/documents/[documentId]. Pins: the public-route
 * block, the org-bound row lookup (IDOR), the MEMBER quote gate (a quote PDF
 * prints deal money — key-redaction can't reach inside a PDF, so the pointer
 * itself is withheld), and the on-disk traversal guard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const fsMock = vi.hoisted(() => ({
  realpath: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("fs/promises", () => ({ default: fsMock, ...fsMock }));

vi.mock("@/lib/db", () => ({
  db: { crmDealDocument: { findFirst: vi.fn() } },
}));

// The gate itself is covered by the source-level gate-drift test; here it's a
// configurable pass-through so each case picks the caller's role.
vi.mock("@/crm/lib/crm-route", () => ({
  requireCrmRead: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
  requireCrmWrite: vi.fn(async () => ({
    ctx: { organizationId: "org-1", userId: "u-1", role: "ADMIN", fromApiKey: false },
  })),
  crmErrorResponse: vi.fn(() => new Response(null, { status: 500 })),
}));

vi.mock("@/crm/services/deal-document-service", () => ({
  removeDealDocument: vi.fn(),
}));

import { db } from "@/lib/db";
import { requireCrmRead } from "@/crm/lib/crm-route";
import { GET as streamDoc } from "@/app/api/crm/deals/[dealId]/documents/[documentId]/route";
import { GET as publicUploads } from "@/app/uploads/[...path]/route";

const ORG = "org-1";
const params = Promise.resolve({ dealId: "d-1", documentId: "doc-1" });
const req = () => new Request("http://test/api/crm/deals/d-1/documents/doc-1");

const pdfDoc = (kind: string) => ({
  url: "/uploads/crm-deal-docs/d-1/abc.pdf",
  filename: "Q-0007.pdf",
  kind,
});

function setRole(role: string, fromApiKey = false) {
  vi.mocked(requireCrmRead).mockResolvedValue({
    ctx: { organizationId: ORG, userId: "u-1", role, fromApiKey },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setRole("ADMIN");
  vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue(pdfDoc("PROSPECTUS") as never);
  // Identity realpath — the file exists exactly where the DB url says.
  fsMock.realpath.mockImplementation(async (p: string) => p);
  fsMock.readFile.mockResolvedValue(Buffer.from("%PDF-1.7 test"));
});

describe("public /uploads catch-all", () => {
  it("BLOCKS the crm-deal-docs prefix — deal files are never publicly guessable", async () => {
    const res = await publicUploads(new Request("http://test/uploads/crm-deal-docs/d-1/abc.pdf"), {
      params: Promise.resolve({ path: ["crm-deal-docs", "d-1", "abc.pdf"] }),
    });
    expect(res.status).toBe(403);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});

describe("GET /api/crm/deals/[dealId]/documents/[documentId] (authed stream)", () => {
  it("binds the row lookup to deal AND org (IDOR)", async () => {
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(200);
    expect(db.crmDealDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-1", dealId: "d-1", organizationId: ORG },
      }),
    );
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("a foreign document 404s", async () => {
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue(null as never);
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("MEMBER cannot stream a QUOTE — the PDF prints the money the redaction hides", async () => {
    setRole("MEMBER");
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue(pdfDoc("QUOTE") as never);
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("MEMBER CAN stream the prospectus (marketing collateral, no money)", async () => {
    setRole("MEMBER");
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue(pdfDoc("PROSPECTUS") as never);
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(200);
  });

  it("a DB url outside the crm-deal-docs root 404s without touching the disk", async () => {
    vi.mocked(db.crmDealDocument.findFirst).mockResolvedValue({
      ...pdfDoc("OTHER"),
      url: "/uploads/photos/2026/07/x.pdf",
    } as never);
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("a symlink escaping the root is blocked after realpath", async () => {
    fsMock.realpath.mockResolvedValue(path.resolve(process.cwd(), "public", "uploads", "photos", "x.pdf"));
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(404);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it("a missing file is an honest FILE_MISSING 404, not a 500", async () => {
    fsMock.realpath.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const res = await streamDoc(req(), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "FILE_MISSING" });
  });
});
