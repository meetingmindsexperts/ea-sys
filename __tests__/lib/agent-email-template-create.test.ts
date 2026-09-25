/**
 * The agent's create_email_template tool (September 22, 2026): a NEW custom
 * template with its own slug, written from a draft the person gives it. It
 * refuses the built-in slugs (those are edits, update_email_template), goes
 * through the same create the dashboard POST uses, audits with the door, and
 * tells the model about tokens no sender fills so it can fix them before a
 * send is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    emailTemplate: { findUnique: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb, tenantTransaction: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/bulk-email", () => ({ executeBulkEmail: vi.fn(), BulkEmailError: class extends Error {} }));

import { COMMUNICATION_EXECUTORS } from "@/lib/agent/tools/communications";
import { collectToolsForActor } from "@/lib/agent/tool-registry";
import { isWriteTool } from "@/lib/agent/tools/_shared";
import { requiresApproval } from "@/lib/agent/approvals";

const ctx = { eventId: "ev1", organizationId: "org1", userId: "u1", source: "agent" as const, counters: { creates: 0, emailsSent: 0 } } as never;
const run = (input: Record<string, unknown>) => COMMUNICATION_EXECUTORS.create_email_template(input, ctx) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.emailTemplate.findUnique.mockResolvedValue(null);
  mockDb.emailTemplate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "tpl-1",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  }));
});

describe("create_email_template", () => {
  it("is a write tool on both doors for an admin, with no approval card", () => {
    for (const source of ["agent", "mcp"] as const) {
      const names = collectToolsForActor({
        organizationId: "org",
        actor: { userId: "u1", role: "ADMIN", fromApiKey: source === "mcp" },
        source,
      }).map((t) => t.name);
      expect(names, source).toContain("create_email_template");
    }
    expect(isWriteTool("create_email_template")).toBe(true);
    expect(requiresApproval("create_email_template")).toBe(false);
  });

  it("needs name, subject and htmlContent", async () => {
    expect(await run({ subject: "s", htmlContent: "<p>x</p>" })).toMatchObject({ code: "MISSING_FIELDS" });
    expect(await run({ name: "n", htmlContent: "<p>x</p>" })).toMatchObject({ code: "MISSING_FIELDS" });
    expect(await run({ name: "n", subject: "s", htmlContent: "   " })).toMatchObject({ code: "MISSING_FIELDS" });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it("refuses a built-in slug and points at update_email_template, writing nothing", async () => {
    const res = await run({ name: "Speaker Invitation", subject: "s", htmlContent: "<p>x</p>" });
    expect(res).toMatchObject({ code: "SYSTEM_SLUG" });
    expect(String(res.error)).toContain("update_email_template");
    expect(mockDb.emailTemplate.findUnique).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
    // The same refusal when the slug is typed rather than derived from the name.
    expect(await run({ name: "Invite", slug: "registration-confirmation", subject: "s", htmlContent: "<p>x</p>" })).toMatchObject({ code: "SYSTEM_SLUG" });
  });

  it("derives the slug from the name, creates on the event, audits with the door", async () => {
    const res = await run({
      name: "Faculty Welcome",
      subject: "Welcome to the faculty",
      htmlContent: "<p>Dear {{speakerName}},</p>{{presentationDetails}}{{agreementBlock}}{{organizerSignature}}",
    });
    expect(res).toMatchObject({ success: true });
    expect(res.template).toMatchObject({ id: "tpl-1", slug: "faculty-welcome", name: "Faculty Welcome", isActive: true });
    expect(mockDb.emailTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventId: "ev1", slug: "faculty-welcome", textContent: null }) }),
    );
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: "ev1",
          userId: "u1",
          action: "CREATE",
          entityType: "EmailTemplate",
          entityId: "tpl-1",
          changes: expect.objectContaining({ source: "agent", slug: "faculty-welcome" }),
        }),
      }),
    );
    expect(String(res.message)).toMatch(/Communications/);
  });

  it("passes a taken slug through as an error the model can act on", async () => {
    mockDb.emailTemplate.findUnique.mockResolvedValue({ id: "tpl-old" });
    const res = await run({ name: "Faculty Welcome", subject: "s", htmlContent: "<p>x</p>" });
    expect(res).toMatchObject({ code: "SLUG_TAKEN" });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an invented token outright, naming it and the tokens it may use, and writes nothing (owner: use existing variables)", async () => {
    const res = await run({
      name: "Faculty Welcome",
      subject: "s",
      htmlContent: "<p>{{speakerName}}, you are entitled to {{accommodationNights}} nights and {{flightTicket}}.</p>",
    });
    expect(res).toMatchObject({ code: "UNKNOWN_TOKENS", unknownTokens: ["accommodationNights", "flightTicket"] });
    expect(res.allowedTokens).toEqual(expect.arrayContaining(["speakerName", "presentationDetails", "agreementBlock", "organizerSignature"]));
    expect(String(res.error)).toContain("{{accommodationNights}}");
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an invented token in the subject too", async () => {
    const res = await run({ name: "Faculty Welcome", subject: "Welcome {{speakerNickname}}", htmlContent: "<p>{{speakerName}}</p>" });
    expect(res).toMatchObject({ code: "UNKNOWN_TOKENS", unknownTokens: ["speakerNickname"] });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });
});

describe("update_email_template audit", () => {
  it("records a rename in fieldsChanged (the production row of September 22, 2026 omitted it)", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValue({ id: "tpl-9", subject: "s", htmlContent: "<p>x</p>", textContent: null });
    mockDb.emailTemplate.update.mockResolvedValue({ id: "tpl-9", slug: "speaker-invitation", name: "Renamed", subject: "s" });
    const res = (await COMMUNICATION_EXECUTORS.update_email_template(
      { slug: "speaker-invitation", name: "Renamed", htmlContent: "<p>Dear {{speakerName}}, y</p>" },
      ctx,
    )) as Record<string, unknown>;
    expect(res).toMatchObject({ success: true });
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changes: expect.objectContaining({ fieldsChanged: ["name", "htmlContent"], name: "Renamed" }),
        }),
      }),
    );
  });
});

describe("update_email_template refuses to repurpose a built-in template", () => {
  // The production case: three invitation drafts written over speaker-invitation,
  // travel-grant-invitation and presenter-agreement, none carrying a token.
  const update = (input: Record<string, unknown>) =>
    COMMUNICATION_EXECUTORS.update_email_template(input, ctx) as Promise<Record<string, unknown>>;

  beforeEach(() => {
    mockDb.emailTemplate.findFirst.mockResolvedValue({ id: "tpl-9", subject: "s", htmlContent: "<p>x</p>", textContent: null });
    mockDb.emailTemplate.update.mockResolvedValue({ id: "tpl-9", slug: "x", name: "n", subject: "s" });
    mockDb.emailTemplate.create.mockResolvedValue({ id: "tpl-10", slug: "x", name: "n", subject: "s" });
  });

  it("refuses a token-free body on each of the three overwritten built-ins, writing nothing, and names the create tool", async () => {
    for (const slug of ["speaker-invitation", "travel-grant-invitation", "presenter-agreement"]) {
      const res = await update({ slug, name: "Speaker Invitation – Local (UAE)", htmlContent: "<p>Dear Doctor, we are delighted to invite you.</p>" });
      expect(res, slug).toMatchObject({ code: "TEMPLATE_TOKENS_DROPPED" });
      expect(String(res.error), slug).toContain("create_email_template");
    }
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("names the tokens the sender fills so the model can keep them", async () => {
    const res = await update({ slug: "travel-grant-invitation", htmlContent: "<p>static</p>" });
    expect(String(res.error)).toMatch(/\{\{speakerName\}\}|\{\{firstName\}\}/);
  });

  it("still edits a built-in whose new body keeps at least one of its tokens", async () => {
    const res = await update({ slug: "travel-grant-invitation", htmlContent: "<p>Dear {{ firstName }},</p>{{travelGrantBlock}}" });
    expect(res).toMatchObject({ success: true });
    expect(mockDb.emailTemplate.update).toHaveBeenCalledTimes(1);
  });

  it("refuses an invented token on an edit of a built-in or a custom template, writing nothing", async () => {
    for (const slug of ["speaker-invitation", "joining-instructions"]) {
      const res = await update({ slug, htmlContent: "<p>Dear {{speakerName}}, {{hotelName}} awaits.</p>" });
      expect(res, slug).toMatchObject({ code: "UNKNOWN_TOKENS", unknownTokens: ["hotelName"] });
      expect(res.allowedTokens, slug).toEqual(expect.arrayContaining(["speakerName", "presentationDetails"]));
    }
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });

  it("does not judge a subject-only edit or a custom template's body", async () => {
    expect(await update({ slug: "speaker-invitation", subject: "New subject" })).toMatchObject({ success: true });
    expect(await update({ slug: "joining-instructions", htmlContent: "<p>Room 4, 9am.</p>" })).toMatchObject({ success: true });
  });
});

describe("duplicate_email_template (September 25, 2026)", () => {
  const dup = (input: Record<string, unknown>) => COMMUNICATION_EXECUTORS.duplicate_email_template(input, ctx) as Promise<Record<string, unknown>>;

  it("is a write tool on both doors for an admin, with no approval card, and list_email_templates points to it", () => {
    for (const source of ["agent", "mcp"] as const) {
      const tools = collectToolsForActor({
        organizationId: "org",
        actor: { userId: "u1", role: "ADMIN", fromApiKey: source === "mcp" },
        source,
      });
      expect(tools.map((t) => t.name), source).toContain("duplicate_email_template");
      expect(tools.find((t) => t.name === "list_email_templates")?.description).toContain("duplicate_email_template");
    }
    expect(isWriteTool("duplicate_email_template")).toBe(true);
    expect(requiresApproval("duplicate_email_template")).toBe(false);
  });

  it("copies the built-in speaker invitation as a disabled custom template, audits it, and says it starts disabled", async () => {
    const res = await dup({ slug: "speaker-invitation" });
    expect(res).toMatchObject({ success: true, duplicatedFrom: "speaker-invitation", template: { slug: "speaker-invitation-copy", isActive: false } });
    expect(String(res.message)).toMatch(/DISABLED/);
    expect(res.unknownTokens).toBeUndefined();
    expect(mockDb.emailTemplate.create.mock.calls[0][0].data.isActive).toBe(false);
    expect(mockDb.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "CREATE", entityType: "EmailTemplate", changes: expect.objectContaining({ source: "agent", duplicatedFrom: { id: null, slug: "speaker-invitation" } }) }),
    }));
  });

  it("does not refuse a copied token no custom sender fills: it reports it, because the agent did not invent it", async () => {
    mockDb.emailTemplate.findUnique.mockImplementation(async ({ where }: { where: { eventId_slug: { slug: string } } }) =>
      where.eventId_slug.slug === "old" ? { id: "t0", slug: "old", name: "Old", subject: "s", htmlContent: "<p>{{madeUpToken}}</p>", textContent: null } : null);
    const res = await dup({ slug: "old" });
    expect(res).toMatchObject({ success: true, unknownTokens: ["madeUpToken"] });
    expect(String(res.message)).toContain("{{madeUpToken}}");
  });

  it("needs a slug and answers an unknown one with SOURCE_NOT_FOUND", async () => {
    expect(await dup({})).toMatchObject({ code: "MISSING_FIELDS" });
    expect(await dup({ slug: "no-such-template" })).toMatchObject({ code: "SOURCE_NOT_FOUND" });
    expect(mockDb.emailTemplate.create).not.toHaveBeenCalled();
  });
});
