/**
 * createCustomEmailTemplate: ONE create for the dashboard's "New template"
 * POST and the agent's create_email_template tool (September 22, 2026). The
 * REST route used to carry the create inline and answered a race between two
 * creates with a raw P2002 500; the agent could not create a template at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { emailTemplate: { findUnique: vi.fn(), create: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  EMAIL_TEMPLATE_SLUG_RE,
  createCustomEmailTemplate,
  slugifyTemplateName,
} from "@/lib/email-template-create";

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.emailTemplate.findUnique.mockResolvedValue(null);
  mockDb.emailTemplate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "tpl-new",
    isActive: true,
    createdAt: new Date("2026-09-22T00:00:00Z"),
    updatedAt: new Date("2026-09-22T00:00:00Z"),
    ...data,
  }));
});

describe("slugifyTemplateName", () => {
  it("is the templates page's rule: lowercase, runs of non-alphanumerics to one hyphen, trimmed", () => {
    expect(slugifyTemplateName("  Faculty Welcome!  ")).toBe("faculty-welcome");
    expect(slugifyTemplateName("Joining instructions (Day 2)")).toBe("joining-instructions-day-2");
    expect(slugifyTemplateName("***")).toBe("");
  });

  it("always yields something the slug rule accepts, or nothing", () => {
    for (const name of ["Faculty Welcome", "A/B test", "Ünïcode name", "x".repeat(300)]) {
      const slug = slugifyTemplateName(name);
      expect(slug === "" || EMAIL_TEMPLATE_SLUG_RE.test(slug), name).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("createCustomEmailTemplate", () => {
  const base = { eventId: "evt-1", name: "Faculty Welcome", subject: "Welcome, {{firstName}}", htmlContent: "<p>Dear {{speakerName}},</p>" };

  it("refuses a slug outside the rule before touching the database", async () => {
    for (const slug of ["", "Faculty Welcome", "faculty_welcome", "a".repeat(101)]) {
      const res = await createCustomEmailTemplate({ ...base, slug });
      expect(res, slug).toMatchObject({ ok: false, code: "INVALID_SLUG" });
    }
    expect(mockDb.emailTemplate.findUnique).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it("answers a taken slug without writing", async () => {
    mockDb.emailTemplate.findUnique.mockResolvedValue({ id: "tpl-old" });
    const res = await createCustomEmailTemplate({ ...base, slug: "faculty-welcome" });
    expect(res).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it("answers the P2002 race as taken rather than throwing", async () => {
    mockDb.emailTemplate.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }),
    );
    const res = await createCustomEmailTemplate({ ...base, slug: "faculty-welcome" });
    expect(res).toMatchObject({ ok: false, code: "SLUG_TAKEN" });
  });

  it("rethrows any other database error (never a silent partial success)", async () => {
    mockDb.emailTemplate.create.mockRejectedValue(new Error("connection closed"));
    await expect(createCustomEmailTemplate({ ...base, slug: "faculty-welcome" })).rejects.toThrow("connection closed");
  });

  it("creates the row with editor-mangled tokens collapsed and null textContent kept as null", async () => {
    const res = await createCustomEmailTemplate({
      ...base,
      slug: "faculty-welcome",
      htmlContent: "<p>Dear {{<span>speakerName</span>}},</p>{{ agreementBlock }}",
      textContent: null,
    });
    expect(res.ok).toBe(true);
    expect(mockDb.emailTemplate.create).toHaveBeenCalledWith({
      data: {
        eventId: "evt-1",
        slug: "faculty-welcome",
        name: "Faculty Welcome",
        subject: "Welcome, {{firstName}}",
        htmlContent: "<p>Dear {{speakerName}},</p>{{agreementBlock}}",
        textContent: null,
      },
    });
    if (res.ok) expect(res.unknownTokens).toEqual([]);
  });

  it("reports tokens no sender fills on a custom template and still creates (the dashboard's warn-only behaviour)", async () => {
    const res = await createCustomEmailTemplate({
      ...base,
      slug: "faculty-welcome",
      htmlContent: "<p>{{speakerName}} {{certificateList}} {{presentationDetails}} {{agreementBlock}}</p>",
    });
    expect(res.ok).toBe(true);
    expect(mockDb.emailTemplate.create).toHaveBeenCalledTimes(1);
    if (res.ok) expect(res.unknownTokens).toEqual(["certificateList"]);
  });

  it("with refuseUnknownTokens, an invented token is refused before any write, with the allowed list", async () => {
    const res = await createCustomEmailTemplate({
      ...base,
      slug: "faculty-welcome",
      htmlContent: "<p>{{speakerName}}, you are entitled to {{accommodationNights}} nights.</p>",
      refuseUnknownTokens: true,
    });
    expect(res).toMatchObject({ ok: false, code: "UNKNOWN_TOKENS", unknownTokens: ["accommodationNights"] });
    if (!res.ok && res.code === "UNKNOWN_TOKENS") {
      expect(res.allowedTokens).toContain("speakerName");
      expect(res.allowedTokens).toContain("presentationDetails");
    }
    expect(mockDb.emailTemplate.findUnique).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });
});
