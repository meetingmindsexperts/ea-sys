/**
 * Email template create + update — body validation (Sep 21, 2026 review, #5).
 *
 * Both handlers read `await req.json()` and destructured it. The create path
 * had a TRUTHINESS check, which is not a type check: `slug: 12345` is truthy,
 * so it reached Prisma and came back as a raw PrismaClientValidationError — a
 * 500 reading "Failed to create email template", telling the organiser nothing
 * and putting nothing useful in /logs.
 *
 * Two things these tests deliberately pin beyond "bad input is a 400":
 *
 *   - the required set is UNCHANGED. `.min(1)` rejects exactly what falsiness
 *     rejected, so an empty string is still refused and nothing that worked
 *     before stops working. A fix that quietly tightened the contract would be
 *     a behaviour change wearing a validation costume.
 *
 * This file covers CREATE only. The UPDATE and preview/test handlers live in
 * the `[templateId]` route, whose import graph is much wider; their body
 * validation is tested in email-template-test-send.test.ts, which already
 * carries every mock that route needs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockDb, mockApiLogger } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    emailTemplate: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      createMany: vi.fn(),
    },
  },
  mockApiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({ apiLogger: mockApiLogger }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/require-org", () => ({
  requireOrgId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/event-access", () => ({
  buildEventAccessWhere: (_u: unknown, id: string) => ({ id }),
}));
vi.mock("@/lib/auth-guards", () => ({
  denyReviewer: () => null,
  WEBINAR_STAFF_ALLOW: {},
}));
vi.mock("@/lib/email", () => ({
  DEFAULT_TEMPLATES: [],
  allTemplateVariables: () => ({}),
}));
vi.mock("@/lib/email-template-slugs", () => ({
  isWebinarTemplateSlug: () => false,
}));

import { POST as CREATE } from "@/app/api/events/[eventId]/email-templates/route";

const params = { params: Promise.resolve({ eventId: "ev1" }) };

function createReq(body: unknown) {
  return new Request("http://t/api/events/ev1/email-templates", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const valid = {
  slug: "my-custom-note",
  name: "My Custom Note",
  subject: "Hello {{firstName}}",
  htmlContent: "<p>Hi</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org-1" } });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.emailTemplate.findUnique.mockResolvedValue(null);
  mockDb.emailTemplate.create.mockResolvedValue({ id: "t1", ...valid });
});

describe("POST email-templates — the happy path is unchanged", () => {
  it("creates a template from a well-formed body", async () => {
    const res = await CREATE(createReq(valid), params);
    expect(res.status).toBe(201);
    expect(mockDb.emailTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventId: "ev1", slug: "my-custom-note" }),
      }),
    );
  });

  it("still accepts an absent textContent (null vs undefined is preserved downstream)", async () => {
    const res = await CREATE(createReq({ ...valid, textContent: undefined }), params);
    expect(res.status).toBe(201);
  });
});

describe("POST email-templates — required fields reject exactly as before", () => {
  it.each([
    ["slug", { ...valid, slug: "" }],
    ["name", { ...valid, name: "" }],
    ["subject", { ...valid, subject: "" }],
    ["htmlContent", { ...valid, htmlContent: "" }],
  ])("refuses an empty %s, as the old truthiness check did", async (_field, body) => {
    const res = await CREATE(createReq(body), params);
    expect(res.status).toBe(400);
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it.each([
    ["slug", { ...valid, slug: undefined }],
    ["htmlContent", { ...valid, htmlContent: undefined }],
  ])("refuses a missing %s", async (_field, body) => {
    const res = await CREATE(createReq(body), params);
    expect(res.status).toBe(400);
  });
});

describe("POST email-templates — wrong types are a 400, not a Prisma 500", () => {
  it("refuses a numeric slug (the exact case that used to reach Prisma)", async () => {
    const res = await CREATE(createReq({ ...valid, slug: 12345 }), params);
    expect(res.status).toBe(400);
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
    // The whole point of the fix: the failure names the field.
    expect((await res.json()).details.fieldErrors.slug).toBeTruthy();
  });

  it("refuses an object htmlContent", async () => {
    const res = await CREATE(createReq({ ...valid, htmlContent: { evil: true } }), params);
    expect(res.status).toBe(400);
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it("refuses a slug with characters the only client cannot produce", async () => {
    // The templates page slugifies to [a-z0-9-] before POSTing, so this is
    // pinning the real contract rather than inventing a stricter one.
    const res = await CREATE(createReq({ ...valid, slug: "Not A Slug!" }), params);
    expect(res.status).toBe(400);
  });

  it("malformed JSON is a 400, not a 500", async () => {
    const res = await CREATE(createReq("{broken"), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_JSON");
  });

  it("logs every refusal — a validation failure must never be silent", async () => {
    await CREATE(createReq({ ...valid, slug: 12345 }), params);
    expect(mockApiLogger.warn).toHaveBeenCalled();
  });
});
