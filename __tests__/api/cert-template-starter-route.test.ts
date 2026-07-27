/**
 * POST /api/events/[eventId]/certificates/templates/starter
 *
 * The "Use standard template" action. What these tests hold in place:
 *   - the auth boundary matches the sibling collection POST exactly (the
 *     starter writes a file AND a row, so a looser guard here would be the
 *     cheapest way into an org's storage)
 *   - the background PDF is stored BEFORE the row is created, so a storage
 *     failure can't leave a row pointing at a PDF that isn't there
 *   - the template adapts to the event's configuration rather than shipping
 *     labels with nothing after them
 *   - auto-issue starts OFF, so creating a starter can never mail certificates
 *     to a tag audience nobody has reviewed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockUpload, mockRateLimit } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    certificateTemplate: { aggregate: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockUpload: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map(Object.entries(init && "headers" in init ? {} : {})),
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/storage", () => ({
  uploadCertificatePdf: (...a: unknown[]) => mockUpload(...a),
}));
vi.mock("@/lib/security", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (session: { user?: { role?: string } } | null) => {
    const role = session?.user?.role;
    const restricted = ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"];
    return role && restricted.includes(role)
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null;
  },
}));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: (session: { user?: { organizationId?: string } } | null) =>
    session?.user?.organizationId
      ? { orgId: session.user.organizationId }
      : { error: { status: 403, json: async () => ({ error: "Forbidden" }) } },
}));

import { POST } from "@/app/api/events/[eventId]/certificates/templates/starter/route";

const adminSession = { user: { id: "user-1", role: "ADMIN", organizationId: "org-1" } };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };

function req(body: unknown = { category: "ATTENDANCE" }) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const fullEvent = {
  id: "evt-1",
  venue: "Conrad Dubai",
  city: "Dubai",
  country: "United Arab Emirates",
  cmeHours: 1.5,
  settings: { cme: { accreditations: [{ body: "OTHER", reference: "OMSB/1" }] } },
};

const bareEvent = {
  id: "evt-1",
  venue: null,
  city: null,
  country: null,
  cmeHours: null,
  settings: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
  mockRateLimit.mockReturnValue({ allowed: true, remaining: 19, retryAfterSeconds: 3600 });
  mockDb.event.findFirst.mockResolvedValue(fullEvent);
  mockUpload.mockResolvedValue("/uploads/certificates/evt-1/2026/07/abc.pdf");
  mockDb.certificateTemplate.aggregate.mockResolvedValue({ _max: { sortOrder: 1 } });
  mockDb.certificateTemplate.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({ id: "tpl-new", ...args.data }),
  );
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      certificateTemplate: {
        aggregate: mockDb.certificateTemplate.aggregate,
        create: mockDb.certificateTemplate.create,
      },
    }),
  );
});

describe("starter template — happy path", () => {
  it("creates a template with a stored background and positioned boxes", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(201);

    // Background stored before the row exists.
    expect(mockUpload).toHaveBeenCalledOnce();
    const [buffer, filename, eventId] = mockUpload.mock.calls[0];
    expect((buffer as Buffer).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(filename).toMatch(/\.pdf$/);
    expect(eventId).toBe("evt-1");

    const data = mockDb.certificateTemplate.create.mock.calls[0][0].data;
    expect(data.name).toBe("Standard Attendance");
    expect(data.category).toBe("ATTENDANCE");
    expect(data.backgroundPdfUrl).toBe("/uploads/certificates/evt-1/2026/07/abc.pdf");
    expect((data.textBoxes as unknown[]).length).toBeGreaterThan(5);
    expect(data.sortOrder).toBe(2); // max+1
  });

  it("starts auto-issue OFF so creating a starter never mails anyone", async () => {
    await POST(req(), params);
    expect(mockDb.certificateTemplate.create.mock.calls[0][0].data.autoIssueOnSurvey).toBe(false);
  });

  it("sets a default role on appreciation and none on attendance", async () => {
    await POST(req({ category: "APPRECIATION" }), params);
    expect(mockDb.certificateTemplate.create.mock.calls[0][0].data.role).toBe("Speaker");

    vi.clearAllMocks();
    mockAuth.mockResolvedValue(adminSession);
    mockRateLimit.mockReturnValue({ allowed: true, remaining: 19, retryAfterSeconds: 3600 });
    mockDb.event.findFirst.mockResolvedValue(fullEvent);
    mockUpload.mockResolvedValue("/uploads/certificates/evt-1/x.pdf");
    mockDb.certificateTemplate.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
    mockDb.certificateTemplate.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({ id: "t", ...args.data }),
    );
    mockDb.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        certificateTemplate: {
          aggregate: mockDb.certificateTemplate.aggregate,
          create: mockDb.certificateTemplate.create,
        },
      }),
    );
    await POST(req({ category: "ATTENDANCE" }), params);
    expect(mockDb.certificateTemplate.create.mock.calls[0][0].data.role).toBeNull();
    expect(mockDb.certificateTemplate.create.mock.calls[0][0].data.sortOrder).toBe(0);
  });

  it("records an audit row naming the starter as the source", async () => {
    await POST(req(), params);
    const changes = mockDb.auditLog.create.mock.calls[0][0].data.changes as Record<string, unknown>;
    expect(mockDb.auditLog.create.mock.calls[0][0].data.action).toBe("CREATE");
    expect(mockDb.auditLog.create.mock.calls[0][0].data.entityType).toBe("CertificateTemplate");
    expect(changes.source).toBe("starter");
    expect(changes.category).toBe("ATTENDANCE");
  });
});

describe("starter template — adapts to the event", () => {
  it("reports nothing omitted for a fully-configured event", async () => {
    const res = await POST(req(), params);
    const body = (await res.json()) as {
      omittedSections: { venue: boolean; accreditation: boolean; cmeHours: boolean };
    };
    expect(body.omittedSections).toEqual({
      venue: false,
      accreditation: false,
      cmeHours: false,
    });
  });

  it("omits accreditation/CME/venue lines on a bare event and says so", async () => {
    mockDb.event.findFirst.mockResolvedValue(bareEvent);
    const res = await POST(req(), params);
    const body = (await res.json()) as {
      omittedSections: { venue: boolean; accreditation: boolean; cmeHours: boolean };
    };
    expect(body.omittedSections).toEqual({ venue: true, accreditation: true, cmeHours: true });

    const boxes = mockDb.certificateTemplate.create.mock.calls[0][0].data
      .textBoxes as Array<{ content: string }>;
    const contents = boxes.map((b) => b.content);
    // No label with an absent value — the dangling-colon case.
    expect(contents.some((c) => c.includes("{{cmeHours}}"))).toBe(false);
    expect(contents.some((c) => c.includes("{{accreditationName}}"))).toBe(false);
    // Identity lines survive.
    expect(contents).toContain("{{recipientName}}");
    expect(contents).toContain("{{eventName}}");
  });

  it("treats a city-only event as having a venue line", async () => {
    mockDb.event.findFirst.mockResolvedValue({ ...bareEvent, city: "Muscat" });
    const res = await POST(req(), params);
    const body = (await res.json()) as { omittedSections: { venue: boolean } };
    expect(body.omittedSections.venue).toBe(false);
  });
});

describe("starter template — guards", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER", "ONSITE"])(
    "403s %s and writes nothing",
    async (role) => {
      mockAuth.mockResolvedValue({ user: { id: "u", role, organizationId: "org-1" } });
      expect((await POST(req(), params)).status).toBe(403);
      expect(mockUpload).not.toHaveBeenCalled();
      expect(mockDb.certificateTemplate.create).not.toHaveBeenCalled();
    },
  );

  it("404s a cross-tenant event without generating a PDF", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockDb.certificateTemplate.create).not.toHaveBeenCalled();
  });

  it("400s an unknown category", async () => {
    expect((await POST(req({ category: "CME" }), params)).status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("400s a missing body", async () => {
    const bad = new Request("http://localhost/api/x", { method: "POST" });
    expect((await POST(bad, params)).status).toBe(400);
  });

  it("429s past the rate limit, before any PDF work", async () => {
    mockRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    expect((await POST(req(), params)).status).toBe(429);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("500s without creating a row when storage fails", async () => {
    mockUpload.mockRejectedValue(new Error("disk full"));
    expect((await POST(req(), params)).status).toBe(500);
    expect(mockDb.certificateTemplate.create).not.toHaveBeenCalled();
  });

  it("does not fail the request when the audit write fails", async () => {
    mockDb.auditLog.create.mockRejectedValue(new Error("pool timeout"));
    const res = await POST(req(), params);
    expect(res.status).toBe(201);
  });
});
