/**
 * GET /api/events/[eventId]/webinar/post-event-report (Nov 23, 2026). Pins: the webinar reports' key,
 * webinars only, survey results only with surveys.read, the PDF is limited, never cached and named
 * after the event, and every refusal is logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: { event: { findFirst: vi.fn() } },
  permSpy: vi.fn(),
  canSpy: vi.fn(),
  loadSpy: vi.fn(),
  pdfSpy: vi.fn(),
  docxSpy: vi.fn(),
  rate: { allowed: true },
}));

vi.mock("next/server", () => {
  class NextResponse {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }
    async json() {
      return JSON.parse(this.body as string);
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(body), init);
    }
  }
  return { NextResponse };
});
vi.mock("@/lib/auth", () => ({ auth: () => h.mockAuth() }));
vi.mock("@/lib/logger", () => ({ apiLogger: h.mockLogger }));
vi.mock("@/lib/db", () => ({ db: h.mockDb }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({ checkRateLimit: () => ({ allowed: h.rate.allowed, retryAfterSeconds: 60 }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: (_s: unknown, key: string) => h.permSpy(key),
}));
vi.mock("@/lib/permissions/can", () => ({ can: (_p: unknown, key: string) => h.canSpy(key) }));
vi.mock("@/lib/tenant/event-tenant", () => ({ findGatedEvent: () => h.mockDb.event.findFirst() }));
vi.mock("@/lib/webinar/post-event-report-server", () => ({ loadPostEventReport: (...a: unknown[]) => h.loadSpy(...a) }));
vi.mock("@/lib/webinar/post-event-report-pdf", () => ({ generatePostEventReportPdf: (...a: unknown[]) => h.pdfSpy(...a) }));
vi.mock("@/lib/webinar/post-event-report-docx", () => ({ generatePostEventReportDocx: (...a: unknown[]) => h.docxSpy(...a) }));
vi.mock("@/lib/webinar/post-event-report-csv", () => ({ postEventReportCsv: () => "\uFEFFSection,Item\r\n" }));

import { GET } from "@/app/api/events/[eventId]/webinar/post-event-report/route";

const ctx = { params: Promise.resolve({ eventId: "ev1" }) };
const req = (q = "") => new Request(`http://localhost/api/events/ev1/webinar/post-event-report${q}`);
const EVENT = {
  id: "ev1",
  slug: "my-webinar",
  eventType: "WEBINAR",
  organizationId: "org1",
  staffAssignments: [],
  organization: { name: "MM Group", companyName: null, companyAddress: null, companyCity: null, companyZipCode: null, companyCountry: null, logo: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.rate.allowed = true;
  h.mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  h.permSpy.mockReturnValue({ ok: true, principal: {}, eventWhere: { id: "ev1" } });
  h.canSpy.mockReturnValue(true);
  h.mockDb.event.findFirst.mockResolvedValue(EVENT);
  h.loadSpy.mockResolvedValue({ event: { id: "ev1" }, surveys: [] });
  h.pdfSpy.mockResolvedValue(Buffer.from("%PDF-1.3 test"));
  h.docxSpy.mockResolvedValue(Buffer.from("PK docx"));
});

describe("the post-event report route", () => {
  it("asks the webinar reports' key, and a refusal stops it", async () => {
    h.permSpy.mockReturnValue({ ok: false, response: { status: 404 } });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.permSpy).toHaveBeenCalledWith("webinar.analytics.read");
    expect(h.loadSpy).not.toHaveBeenCalled();
  });

  it("survey results only for a caller who may read them", async () => {
    await GET(req(), ctx);
    expect(h.canSpy).toHaveBeenCalledWith("surveys.read");
    expect(h.loadSpy.mock.calls[0][1]).toEqual({ includeSurveys: true, includeComments: true });
    h.canSpy.mockReturnValue(false);
    await GET(req(), ctx);
    expect(h.loadSpy.mock.calls[1][1]).toEqual({ includeSurveys: false, includeComments: true });
  });

  it("the PDF carries survey comments only when asked (the console's download never asks)", async () => {
    await GET(req("?format=pdf"), ctx);
    expect(h.loadSpy.mock.calls[0][1]).toMatchObject({ includeComments: false });
    await GET(req("?format=pdf&comments=1"), ctx);
    expect(h.loadSpy.mock.calls[1][1]).toMatchObject({ includeComments: true });
  });

  it("webinars only: a conference is a logged 409", async () => {
    h.mockDb.event.findFirst.mockResolvedValue({ ...EVENT, eventType: "CONFERENCE" });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(409);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "post-event-report:not-a-webinar");
  });

  it("an event not found through the gate is a logged 404", async () => {
    h.mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.anything(), "post-event-report:event-not-found");
  });

  it("the PDF: never cached, named after the event, and limited per person", async () => {
    const res = (await GET(req("?format=pdf"), ctx)) as unknown as { status: number; headers: Record<string, string> };
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/pdf");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(res.headers["Content-Disposition"]).toContain("post-event-report-my-webinar.pdf");
    h.rate.allowed = false;
    const limited = await GET(req("?format=pdf"), ctx);
    expect(limited.status).toBe(429);
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1", format: "pdf" }), "post-event-report:rate-limited");
  });

  it("the Word copy and the CSV: same rules as the PDF, their own type and name, one shared limit", async () => {
    type FileRes = { status: number; headers: Record<string, string> };
    const docx = (await GET(req("?format=docx"), ctx)) as unknown as FileRes;
    expect(docx.status).toBe(200);
    expect(docx.headers["Content-Type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(docx.headers["Content-Disposition"]).toContain("post-event-report-my-webinar.docx");
    expect(docx.headers["Cache-Control"]).toBe("private, no-store");
    const csv = (await GET(req("?format=csv&comments=1"), ctx)) as unknown as FileRes;
    expect(csv.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(csv.headers["Content-Disposition"]).toContain("post-event-report-my-webinar.csv");
    // Comments only when asked, as for the PDF.
    expect(h.loadSpy.mock.calls[0][1]).toMatchObject({ includeComments: false });
    expect(h.loadSpy.mock.calls[1][1]).toMatchObject({ includeComments: true });
    expect(h.pdfSpy).not.toHaveBeenCalled();
    h.rate.allowed = false;
    expect((await GET(req("?format=csv"), ctx)).status).toBe(429);
  });

  it("an unknown format is a logged 400, before anything is read", async () => {
    const res = await GET(req("?format=xlsx"), ctx);
    expect(res.status).toBe(400);
    expect(h.loadSpy).not.toHaveBeenCalled();
    expect(h.mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ format: "xlsx" }), "post-event-report:unknown-format");
  });

  it("a failure is a logged 500", async () => {
    h.loadSpy.mockRejectedValue(new Error("boom"));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    expect(h.mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: "ev1" }), "post-event-report:failed");
  });
});
