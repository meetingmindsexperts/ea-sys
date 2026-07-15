/**
 * CRM email-template service.
 *
 * Pins: seed-once (idempotent — never resurrect after archive-all), the required
 * fields, org-bound update/archive (never trust the id alone), and archive/restore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmEmailTemplate: {
      count: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import {
  ensureCrmEmailTemplates,
  createCrmEmailTemplate,
  updateCrmEmailTemplate,
  setCrmEmailTemplateArchived,
} from "@/crm/services/crm-email-template-service";
import { CRM_EMAIL_TEMPLATES } from "@/crm/lib/crm-email-templates";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  // createCrmEmailTemplate runs inside $transaction — pass a tx with the two calls it uses.
  vi.mocked(db.$transaction).mockImplementation(async (fn: unknown) =>
    (fn as (tx: unknown) => unknown)({
      crmEmailTemplate: {
        aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: 2 } }),
        create: vi.fn().mockResolvedValue({ id: "t-new", name: "X", subject: "S", sortOrder: 3 }),
      },
    }),
  );
});

describe("ensureCrmEmailTemplates — seed once", () => {
  it("seeds the built-ins when the org has none", async () => {
    vi.mocked(db.crmEmailTemplate.count).mockResolvedValue(0 as never);
    await ensureCrmEmailTemplates(ORG);
    expect(db.crmEmailTemplate.createMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(db.crmEmailTemplate.createMany).mock.calls[0][0] as { data: unknown[] };
    expect(arg.data).toHaveLength(CRM_EMAIL_TEMPLATES.length);
  });

  it("does NOT re-seed when any row exists (even if all archived)", async () => {
    vi.mocked(db.crmEmailTemplate.count).mockResolvedValue(3 as never);
    await ensureCrmEmailTemplates(ORG);
    expect(db.crmEmailTemplate.createMany).not.toHaveBeenCalled();
  });
});

describe("createCrmEmailTemplate", () => {
  it("requires name, subject and body", async () => {
    expect(await createCrmEmailTemplate({ ...base, name: " ", subject: "s", body: "b" })).toMatchObject({ code: "NAME_REQUIRED" });
    expect(await createCrmEmailTemplate({ ...base, name: "n", subject: " ", body: "b" })).toMatchObject({ code: "SUBJECT_REQUIRED" });
    expect(await createCrmEmailTemplate({ ...base, name: "n", subject: "s", body: " " })).toMatchObject({ code: "BODY_REQUIRED" });
  });

  it("creates at the next sortOrder", async () => {
    const res = await createCrmEmailTemplate({ ...base, name: "Prospectus", subject: "Sub", body: "<p>Hi</p>" });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalled();
  });
});

describe("updateCrmEmailTemplate — org-bound", () => {
  it("404s an id that isn't in this org (updateMany affects 0 rows)", async () => {
    vi.mocked(db.crmEmailTemplate.updateMany).mockResolvedValue({ count: 0 } as never);
    const res = await updateCrmEmailTemplate({ ...base, templateId: "other", name: "New" });
    expect(res).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
    expect(db.crmEmailTemplate.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("updates and returns the row", async () => {
    vi.mocked(db.crmEmailTemplate.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmEmailTemplate.findUniqueOrThrow).mockResolvedValue({ id: "t-1", name: "New" } as never);
    const res = await updateCrmEmailTemplate({ ...base, templateId: "t-1", subject: "S2" });
    expect(res.ok).toBe(true);
    expect(vi.mocked(db.crmEmailTemplate.updateMany).mock.calls[0][0]).toMatchObject({
      where: { id: "t-1", organizationId: ORG },
    });
  });
});

describe("setCrmEmailTemplateArchived", () => {
  it("archives (sets archivedAt)", async () => {
    vi.mocked(db.crmEmailTemplate.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmEmailTemplate.findUniqueOrThrow).mockResolvedValue({ id: "t-1", name: "P" } as never);
    const res = await setCrmEmailTemplateArchived({ ...base, templateId: "t-1", archived: true });
    expect(res.ok).toBe(true);
    const call = vi.mocked(db.crmEmailTemplate.updateMany).mock.calls[0][0] as { data: { archivedAt: Date | null } };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it("restores (clears archivedAt)", async () => {
    vi.mocked(db.crmEmailTemplate.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmEmailTemplate.findUniqueOrThrow).mockResolvedValue({ id: "t-1", name: "P" } as never);
    const res = await setCrmEmailTemplateArchived({ ...base, templateId: "t-1", archived: false });
    expect(res.ok).toBe(true);
    const call = vi.mocked(db.crmEmailTemplate.updateMany).mock.calls[0][0] as { data: { archivedAt: Date | null } };
    expect(call.data.archivedAt).toBeNull();
  });

  it("404s an id outside the org", async () => {
    vi.mocked(db.crmEmailTemplate.updateMany).mockResolvedValue({ count: 0 } as never);
    const res = await setCrmEmailTemplateArchived({ ...base, templateId: "x", archived: true });
    expect(res).toMatchObject({ ok: false, code: "TEMPLATE_NOT_FOUND" });
  });
});
