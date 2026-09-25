/**
 * createCustomEmailTemplate: ONE create for the dashboard's "New template"
 * POST and the agent's create_email_template tool (September 22, 2026). The
 * REST route used to carry the create inline and answered a race between two
 * creates with a raw P2002 500; the agent could not create a template at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { emailTemplate: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  EMAIL_TEMPLATE_SLUG_RE,
  EMAIL_TEMPLATE_SLUG_MAX,
  copyName,
  copySlug,
  createCustomEmailTemplate,
  duplicateEmailTemplate,
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

describe("duplicateEmailTemplate", () => {
  const src = { id: "tpl-src", slug: "faculty-welcome", name: "Faculty Welcome", subject: "Welcome to {{eventName}}", htmlContent: "<p>Dear {{speakerName}}</p>{{agreementBlock}}", textContent: "Dear {{speakerName}}" };
  const taken = (...slugs: string[]) =>
    mockDb.emailTemplate.findUnique.mockImplementation(async ({ where }: { where: { eventId_slug: { slug: string } } }) =>
      where.eventId_slug.slug === src.slug ? src : slugs.includes(where.eventId_slug.slug) ? { id: "x" } : null);

  it("copies subject and both bodies into a custom template that starts disabled, named and slugged as the first copy", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValueOnce(src);
    const r = await duplicateEmailTemplate({ eventId: "ev1", sourceId: "tpl-src" });
    expect(r).toMatchObject({ ok: true, source: { id: "tpl-src", slug: "faculty-welcome" } });
    expect(mockDb.emailTemplate.findFirst.mock.calls[0][0].where).toEqual({ id: "tpl-src", eventId: "ev1" });
    expect(mockDb.emailTemplate.create.mock.calls[0][0].data).toEqual({
      eventId: "ev1", slug: "faculty-welcome-copy", name: "Faculty Welcome (copy)",
      subject: src.subject, htmlContent: src.htmlContent, textContent: src.textContent, isActive: false,
    });
  });

  it("numbers the next copy when the first name is taken", async () => {
    taken("faculty-welcome-copy", "faculty-welcome-copy-2");
    const r = await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "faculty-welcome" });
    expect(r.ok && r.template).toMatchObject({ slug: "faculty-welcome-copy-3", name: "Faculty Welcome (copy 3)" });
  });

  it("moves to the next number when a concurrent copy wins the race on the unique index", async () => {
    taken();
    mockDb.emailTemplate.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6" }));
    const r = await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "faculty-welcome" });
    expect(r.ok && r.template.slug).toBe("faculty-welcome-copy-2");
  });

  it("copies a built-in from its default text when the event has no row for it yet, into a custom slug", async () => {
    const r = await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "speaker-invitation" });
    expect(r).toMatchObject({ ok: true, source: { id: null, slug: "speaker-invitation" } });
    const data = mockDb.emailTemplate.create.mock.calls[0][0].data;
    expect(data.slug).toBe("speaker-invitation-copy");
    expect(data.isActive).toBe(false);
    expect(data.htmlContent).toContain("{{");
  });

  it("keeps the source's speaker tokens: a custom template sent to speakers fills them", async () => {
    taken();
    const r = await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "faculty-welcome" });
    expect(r.ok && r.unknownTokens).toEqual([]);
  });

  it("uses a typed name as is, with its own slug, and numbers it only when taken", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValue(src);
    const first = await duplicateEmailTemplate({ eventId: "ev1", sourceId: "tpl-src", name: "  Chair welcome " });
    expect(first.ok && first.template).toMatchObject({ slug: "chair-welcome", name: "Chair welcome" });
    mockDb.emailTemplate.findUnique.mockImplementation(async ({ where }: { where: { eventId_slug: { slug: string } } }) => (where.eventId_slug.slug === "chair-welcome" ? { id: "x" } : null));
    const second = await duplicateEmailTemplate({ eventId: "ev1", sourceId: "tpl-src", name: "Chair welcome" });
    expect(second.ok && second.template).toMatchObject({ slug: "chair-welcome-copy-2", name: "Chair welcome (copy 2)" });
  });

  it("refuses an unknown source, a name with no letters, and gives up after fifty taken numbers", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValueOnce(null);
    expect(await duplicateEmailTemplate({ eventId: "ev1", sourceId: "nope" })).toMatchObject({ ok: false, code: "SOURCE_NOT_FOUND" });
    expect(await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "no-such-template" })).toMatchObject({ ok: false, code: "SOURCE_NOT_FOUND" });
    taken();
    expect(await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "faculty-welcome", name: "***" })).toMatchObject({ ok: false, code: "INVALID_NAME" });
    mockDb.emailTemplate.findUnique.mockImplementation(async ({ where }: { where: { eventId_slug: { slug: string } } }) => (where.eventId_slug.slug === src.slug ? src : { id: "x" }));
    expect(await duplicateEmailTemplate({ eventId: "ev1", sourceSlug: "faculty-welcome" })).toMatchObject({ ok: false, code: "NO_FREE_SLUG" });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });
});

describe("copySlug and copyName", () => {
  it("number from the second copy and stay inside the limits without a dangling hyphen", () => {
    expect(copySlug("abc", 1)).toBe("abc-copy");
    expect(copySlug("abc", 7)).toBe("abc-copy-7");
    const long = `${"a".repeat(91)}-bbbbbbbb`; // the cut at 92 lands on the hyphen
    const s = copySlug(long, 12);
    expect(s.length).toBeLessThanOrEqual(EMAIL_TEMPLATE_SLUG_MAX);
    expect(s).toMatch(EMAIL_TEMPLATE_SLUG_RE);
    expect(s).not.toContain("--");
    expect(copyName("Welcome", 1)).toBe("Welcome (copy)");
    expect(copyName("x".repeat(250), 3).length).toBe(200);
  });
});
