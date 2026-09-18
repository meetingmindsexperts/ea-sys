/**
 * resetEmailTemplateToDefault: ONE reset for the dashboard PATCH and the MCP
 * reset_email_template tool (September 18, 2026). The MCP tool used to DELETE
 * the row for any slug, which destroyed the only copy of an organizer-created
 * template; the dashboard overwrote a system template in place. Both now do
 * the latter and refuse a custom slug.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { emailTemplate: { findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { resetEmailTemplateToDefault } from "@/lib/email-template-reset";
import { getDefaultTemplate } from "@/lib/email";

beforeEach(() => vi.clearAllMocks());

describe("resetEmailTemplateToDefault", () => {
  it("refuses a custom slug and touches nothing (the only copy would be lost)", async () => {
    const res = await resetEmailTemplateToDefault({ eventId: "evt-1", slug: "joining-instructions" });
    expect(res).toMatchObject({ ok: false, code: "CUSTOM_SLUG" });
    expect(mockDb.emailTemplate.findFirst).not.toHaveBeenCalled();
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
  });

  it("overwrites a system template in place with the default text and re-enables it; never deletes", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValue({ id: "tpl-1" });
    mockDb.emailTemplate.update.mockResolvedValue({ id: "tpl-1", slug: "registration-confirmation", name: "Registration Confirmation", subject: "s", isActive: true });
    const res = await resetEmailTemplateToDefault({ eventId: "evt-1", slug: "registration-confirmation" });
    expect(res.ok).toBe(true);
    const def = getDefaultTemplate("registration-confirmation")!;
    expect(mockDb.emailTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tpl-1" },
        data: { subject: def.subject, htmlContent: def.htmlContent, textContent: def.textContent, name: def.name, isActive: true },
      }),
    );
    expect(mockDb.emailTemplate).not.toHaveProperty("delete");
  });

  it("with no saved row there is nothing to reset: ok, template null, no write", async () => {
    mockDb.emailTemplate.findFirst.mockResolvedValue(null);
    const res = await resetEmailTemplateToDefault({ eventId: "evt-1", slug: "event-reminder" });
    expect(res).toEqual({ ok: true, template: null });
    expect(mockDb.emailTemplate.update).not.toHaveBeenCalled();
  });
});
