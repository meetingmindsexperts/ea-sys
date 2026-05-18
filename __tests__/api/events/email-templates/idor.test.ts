/**
 * Pins the fix for the cross-tenant IDOR found in the May 2026 audit
 * (BLOCKER). GET/PUT/DELETE/POST/PATCH on
 *   /api/events/[eventId]/email-templates/[templateId]
 * resolved the template by { id, eventId } only — both from the URL, no
 * organizationId binding — so any authenticated user in any org could
 * read / overwrite / reset / delete another org's email templates.
 *
 * Every handler must now bind the event to the caller's org BEFORE
 * touching (or mutating) the template, returning 404 on a cross-tenant id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    emailTemplate: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: { set: vi.fn() },
    }),
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: (s: { user?: { role?: string } } | null) =>
    ["REVIEWER", "SUBMITTER", "REGISTRANT", "MEMBER"].includes(s?.user?.role ?? "")
      ? { status: 403, json: async () => ({ error: "Forbidden" }) }
      : null,
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
  renderTemplate: vi.fn(() => ""),
  renderTemplatePlain: vi.fn(() => ""),
  getDefaultTemplate: vi.fn(() => ({ subject: "", htmlContent: "", textContent: "", name: "" })),
  TEMPLATE_VARIABLES: {},
  wrapWithBranding: vi.fn(() => ""),
  inlineCss: vi.fn(() => ""),
  brandingFrom: vi.fn(() => ({})),
  getSamplePreviewVariables: vi.fn(() => ({})),
}));

import { GET, PUT, DELETE, PATCH } from "@/app/api/events/[eventId]/email-templates/[templateId]/route";

const params = Promise.resolve({ eventId: "ev-OTHER-ORG", templateId: "tpl-1" });
const adminSession = { user: { id: "u1", role: "ADMIN", organizationId: "orgA" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

describe("email-templates/[templateId] tenant isolation", () => {
  it("GET: cross-tenant event → 404, template never read", async () => {
    mockDb.event.findFirst.mockResolvedValue(null); // not in caller's org
    const res = await GET(new Request("http://t"), { params });
    expect(res.status).toBe(404);
    expect(mockDb.event.findFirst).toHaveBeenCalledWith({
      where: { id: "ev-OTHER-ORG", organizationId: "orgA" },
      select: { id: true },
    });
    expect(mockDb.emailTemplate.findFirst).not.toHaveBeenCalled();
  });

  it("GET: same-org event → template returned", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    mockDb.emailTemplate.findFirst.mockResolvedValue({ id: "tpl-1", slug: "x" });
    const res = await GET(new Request("http://t"), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).template.id).toBe("tpl-1");
  });

  it("DELETE: cross-tenant → 404 and template.delete NEVER called", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await DELETE(new Request("http://t"), { params });
    expect(res.status).toBe(404);
    expect(mockDb.emailTemplate.delete).not.toHaveBeenCalled();
  });

  it("PUT: cross-tenant → 404 and template.update NEVER called", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await PUT(
      new Request("http://t", { method: "PUT", body: JSON.stringify({ subject: "hacked" }) }),
      { params },
    );
    expect(res.status).toBe(404);
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
  });

  it("PATCH (reset-to-default): cross-tenant → 404 and update NEVER called", async () => {
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await PATCH(new Request("http://t", { method: "PATCH" }), { params });
    expect(res.status).toBe(404);
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
  });
});
