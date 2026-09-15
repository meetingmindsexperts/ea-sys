/**
 * GET /api/events/[eventId]/reimbursements/[reimbursementId]/pdf (Sep 15, 2026).
 *
 *   - the reimbursement boundary through the REAL denyReviewer: MEMBER / ONSITE
 *     refused before any read; ADMIN / ORGANIZER pass
 *   - only a SUBMITTED form prints (409 NOT_SUBMITTED otherwise, nothing
 *     rendered, nothing audited)
 *   - a download renders on demand, is sent as an attachment with no caching,
 *     and is recorded as an export
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, mockRateLimit, mockGenerate, mockRecordExport } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    speakerReimbursement: { findFirst: vi.fn() },
  },
  mockAuth: vi.fn(),
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockGenerate: vi.fn(),
  mockRecordExport: vi.fn(),
}));

vi.mock("next/server", () => {
  class MockNextResponse {
    status: number;
    headers: Map<string, string>;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }
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
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: mockRecordExport }));
vi.mock("@/lib/reimbursement/reimbursement-pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reimbursement/reimbursement-pdf")>()),
  generateReimbursementPdf: mockGenerate,
}));

import { GET } from "@/app/api/events/[eventId]/reimbursements/[reimbursementId]/pdf/route";

const params = () => ({ params: Promise.resolve({ eventId: "evt1", reimbursementId: "r1" }) }) as never;
const session = (role: string) => ({ user: { id: "u1", role, organizationId: "org1" } });
const req = () => ({ headers: new Map() }) as never;

const EVENT = {
  id: "evt1",
  name: "BRIDGES 2026",
  startDate: new Date("2026-10-01T05:00:00Z"),
  endDate: new Date("2026-10-03T12:00:00Z"),
  venue: "Conrad",
  city: "Dubai",
  organizationId: "org1",
  organization: {
    name: "MM Group", logo: null, companyName: "Meeting Minds FZ LLC", companyAddress: null,
    companyCity: null, companyState: null, companyZipCode: null, companyCountry: null, taxId: null,
  },
};

const ROW = {
  id: "r1",
  status: "SUBMITTED",
  fullName: "Ahmed Osman",
  designation: null, institution: null, country: "UAE", email: "a@example.com", phone: null,
  nationality: "Egyptian", passportNumber: "A1234567", roleAtEvent: "Speaker",
  claimLines: [{ item: "FLIGHT", currency: "USD", amount: 100 }],
  bankDetails: { beneficiaryName: "Ahmed", bankName: "ENBD", iban: "AE07", swift: "EBILAEAD" },
  signedName: "Ahmed Osman",
  submittedAt: new Date("2026-09-14T10:30:00Z"),
  documents: [{ kind: "PASSPORT", filename: "passport.pdf", size: 100 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockAuth.mockResolvedValue(session("ADMIN"));
  mockDb.event.findFirst.mockResolvedValue(EVENT);
  mockDb.speakerReimbursement.findFirst.mockResolvedValue(ROW);
  mockGenerate.mockResolvedValue(Buffer.from("%PDF-1.3 fake"));
});

describe("access", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(401);
  });

  it.each(["MEMBER", "ONSITE", "REVIEWER", "REGISTRANT"])("403 for %s, before any read", async (role) => {
    mockAuth.mockResolvedValue(session(role));
    expect((await GET(req(), params())).status).toBe(403);
    expect(mockDb.speakerReimbursement.findFirst).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("an organizer may download", async () => {
    mockAuth.mockResolvedValue(session("ORGANIZER"));
    expect((await GET(req(), params())).status).toBe(200);
  });

  it("429 past the hourly limit, without rendering", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 120 });
    expect((await GET(req(), params())).status).toBe(429);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("404 when the event is not reachable", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
  });

  it("404 when the reimbursement is not on this event", async () => {
    mockDb.speakerReimbursement.findFirst.mockResolvedValue(null);
    expect((await GET(req(), params())).status).toBe(404);
    expect(mockDb.speakerReimbursement.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", eventId: "evt1" } }),
    );
  });
});

describe("only a submitted claim prints", () => {
  it("409 NOT_SUBMITTED for a pending or reopened form, nothing rendered or audited", async () => {
    mockDb.speakerReimbursement.findFirst.mockResolvedValue({ ...ROW, status: "PENDING" });
    const res = (await GET(req(), params())) as unknown as { status: number; json: () => Promise<{ code: string }> };
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NOT_SUBMITTED");
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockRecordExport).not.toHaveBeenCalled();
  });
});

describe("download", () => {
  it("renders the stored submission and sends it as an uncached attachment", async () => {
    const res = (await GET(req(), params())) as unknown as { status: number; headers: Map<string, string> };
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="reimbursement-bridges-2026-ahmed-osman.pdf"',
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");

    const data = mockGenerate.mock.calls[0]![0];
    expect(data.speaker.passportNumber).toBe("A1234567");
    expect(data.bankDetails).toEqual(ROW.bankDetails);
    expect(data.documents).toEqual(ROW.documents);
    expect(data.organization.companyName).toBe("Meeting Minds FZ LLC");
  });

  it("records the download as a one-row PDF export", async () => {
    await GET(req(), params());
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: "SpeakerReimbursement",
        eventId: "evt1",
        organizationId: "org1",
        userId: "u1",
        rowCount: 1,
        format: "pdf",
        filters: { reimbursementId: "r1" },
      }),
    );
  });

  it("500 and nothing audited when rendering fails", async () => {
    mockGenerate.mockRejectedValue(new Error("boom"));
    expect((await GET(req(), params())).status).toBe(500);
    expect(mockRecordExport).not.toHaveBeenCalled();
  });
});
