/**
 * Unit tests for POST
 *   /api/events/[eventId]/certificates/templates/[templateId]/duplicate
 * — the "duplicate certificate template" action.
 *
 * Pins the H4 regression: the clone must carry role / cmeHours / autoIssueTag
 * (a hand-listed field copy silently dropped these), while auto-issue starts
 * PAUSED on the copy (autoIssueOnSurvey: false) so a live clone can't instantly
 * double-issue the source's tag audience — and the response flags that so the
 * UI can prompt a re-enable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUpload, mockLoadPdf } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    certificateTemplate: { findFirst: vi.fn(), aggregate: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockUpload: vi.fn(),
  mockLoadPdf: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/storage", () => ({ uploadCertificatePdf: (...a: unknown[]) => mockUpload(...a) }));
vi.mock("@/lib/certificates/pdf-loader", () => ({
  loadCertificatePdfBytes: (...a: unknown[]) => mockLoadPdf(...a),
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    const restricted = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"];
    return role && restricted.includes(role) ? { status: 403, json: async () => ({ error: "Forbidden" }) } : null;
  },
}));

import { POST } from "@/app/api/events/[eventId]/certificates/templates/[templateId]/duplicate/route";

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const params = { params: Promise.resolve({ eventId: "evt-1", templateId: "tpl-src" }) };
const req = () => new Request("http://localhost/api/x", { method: "POST" });

const source = {
  id: "tpl-src",
  eventId: "evt-1",
  name: "Chairman Appreciation",
  category: "APPRECIATION",
  backgroundPdfUrl: null,
  textBoxes: [{ id: "b1" }],
  sortOrder: 2,
  emailSubject: "Subj",
  emailBody: "Body",
  role: "Chairperson",
  cmeHours: 6,
  autoIssueOnSurvey: true,
  autoIssueTag: "faculty",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockDb.certificateTemplate.findFirst.mockResolvedValue(source);
  mockDb.certificateTemplate.aggregate.mockResolvedValue({ _max: { sortOrder: 4 } });
  mockDb.certificateTemplate.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "tpl-clone",
    ...args.data,
  }));
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb.certificateTemplate) => unknown) =>
    cb({
      certificateTemplate: {
        aggregate: mockDb.certificateTemplate.aggregate,
        create: mockDb.certificateTemplate.create,
      },
    } as unknown as typeof mockDb.certificateTemplate),
  );
});

describe("POST duplicate certificate template — H4 field copy", () => {
  it("copies role / cmeHours / autoIssueTag but starts auto-issue PAUSED", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(201);

    const created = mockDb.certificateTemplate.create.mock.calls[0][0].data;
    expect(created.role).toBe("Chairperson");
    expect(created.cmeHours).toBe(6);
    expect(created.autoIssueTag).toBe("faculty");
    // Deliberately OFF on the clone (no instant double-issue of the tag audience).
    expect(created.autoIssueOnSurvey).toBe(false);
    // Sanity: the fields that were already copied still are.
    expect(created.name).toBe("Chairman Appreciation (copy)");
    expect(created.category).toBe("APPRECIATION");
    expect(created.emailSubject).toBe("Subj");
    expect(created.sortOrder).toBe(5);

    const body = await res.json();
    // Source had auto-issue ON, so the clone flags it as paused for the UI.
    expect(body.autoIssuePaused).toBe(true);
  });

  it("does not flag autoIssuePaused when the source had auto-issue off", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue({ ...source, autoIssueOnSurvey: false });
    const res = await POST(req(), params);
    const body = await res.json();
    expect(body.autoIssuePaused).toBe(false);
    expect(mockDb.certificateTemplate.create.mock.calls[0][0].data.autoIssueOnSurvey).toBe(false);
  });

  it("404s cross-tenant without creating anything", async () => {
    mockDb.certificateTemplate.findFirst.mockResolvedValue(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(404);
    expect(mockDb.certificateTemplate.create).not.toHaveBeenCalled();
  });
});
