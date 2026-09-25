/**
 * POST /api/events/[eventId]/email-templates/[templateId]/duplicate
 * (September 25, 2026): the dashboard's Duplicate button. The copy itself is
 * duplicateEmailTemplate (pinned in email-template-create.test.ts); this pins
 * the route around it: who may call it, that the event is resolved through
 * the caller's access BEFORE anything is copied, the body, the status codes,
 * and the audit row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger, mockDuplicate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  mockDuplicate: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: { set: vi.fn() } }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({
  WEBINAR_STAFF_ALLOW: ["WEBINARS"],
  denyReviewer: (s: { user?: { role?: string } } | null) =>
    ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER"].includes(s?.user?.role ?? "")
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null,
}));
vi.mock("@/lib/email-template-create", () => ({ duplicateEmailTemplate: mockDuplicate }));

import { POST } from "@/app/api/events/[eventId]/email-templates/[templateId]/duplicate/route";

const params = () => ({ params: Promise.resolve({ eventId: "ev1", templateId: "tpl-src" }) });
const req = (body?: string) => new Request("http://localhost/x", { method: "POST", ...(body !== undefined && { body }) });
const admin = { user: { id: "u1", role: "ADMIN", organizationId: "orgA" } };
const copy = { id: "tpl-copy", eventId: "ev1", slug: "speaker-invitation-copy", name: "Speaker Invitation (copy)", subject: "s", htmlContent: "h", textContent: null, isActive: false, createdAt: new Date(), updatedAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(admin);
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.auditLog.create.mockResolvedValue({});
  mockDuplicate.mockResolvedValue({ ok: true, template: copy, source: { id: "tpl-src", slug: "speaker-invitation", name: "Speaker Invitation" }, unknownTokens: [] });
});

describe("duplicate route", () => {
  it("copies with an empty body, answers 201 with the disabled copy, and audits where it came from", async () => {
    const res = await POST(req(), params());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "tpl-copy", isActive: false, unfillableTokens: [] });
    expect(mockDuplicate).toHaveBeenCalledWith({ eventId: "ev1", sourceId: "tpl-src", name: undefined });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CREATE", entityType: "EmailTemplate", entityId: "tpl-copy", changes: expect.objectContaining({ source: "rest", duplicatedFrom: { id: "tpl-src", slug: "speaker-invitation" } }) }),
    });
  });

  it("passes a typed name through", async () => {
    await POST(req(JSON.stringify({ name: "Chair welcome" })), params());
    expect(mockDuplicate).toHaveBeenCalledWith({ eventId: "ev1", sourceId: "tpl-src", name: "Chair welcome" });
  });

  it("resolves the event through the caller's access first: another org's event is a 404 and nothing is copied", async () => {
    mockDb.event.findFirst.mockResolvedValueOnce(null);
    const res = await POST(req(), params());
    expect(res.status).toBe(404);
    expect(mockDuplicate).not.toHaveBeenCalled();
  });

  it("refuses an unsigned caller and the read-only and external roles before anything else", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await POST(req(), params())).status).toBe(401);
    for (const role of ["MEMBER", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      mockAuth.mockResolvedValueOnce({ user: { id: "u2", role, organizationId: "orgA" } });
      expect((await POST(req(), params())).status, role).toBe(403);
    }
    expect(mockDuplicate).not.toHaveBeenCalled();
  });

  it("maps the refusals and logs each one", async () => {
    mockDuplicate.mockResolvedValueOnce({ ok: false, code: "SOURCE_NOT_FOUND", message: "m" });
    expect((await POST(req(), params())).status).toBe(404);
    mockDuplicate.mockResolvedValueOnce({ ok: false, code: "NO_FREE_SLUG", message: "m" });
    expect((await POST(req(), params())).status).toBe(409);
    mockDuplicate.mockResolvedValueOnce({ ok: false, code: "INVALID_NAME", message: "m" });
    expect((await POST(req(), params())).status).toBe(400);
    expect(mockApiLogger.warn).toHaveBeenCalledTimes(3);
  });

  it("answers malformed JSON and a bad name with a logged 400", async () => {
    expect((await POST(req("{nope"), params())).status).toBe(400);
    expect((await POST(req(JSON.stringify({ name: "" })), params())).status).toBe(400);
    expect(mockDuplicate).not.toHaveBeenCalled();
    expect(mockApiLogger.warn).toHaveBeenCalled();
  });
});
