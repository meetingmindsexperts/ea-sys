/**
 * CRM data retention (CRM product review P1-9, Nov 6, 2026): off by default and
 * on a corrupt block; bounded periods; the worker deletes only what is older
 * than an organisation's own period, audits it in the same transaction, and
 * removes the attachment files afterwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, remove } = vi.hoisted(() => {
  const db = {
    organization: { findMany: vi.fn() },
    crmEmailThread: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    crmNote: { findMany: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db, remove: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/db", () => ({ db, dbOperator: db, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/crm/integrations/storage", () => ({ crmStorage: { remove } }));

import { crmRetentionSchema, readCrmRetention, retentionCutoff, RETENTION_OFF } from "@/crm/lib/retention-rules";
import { runRetentionTick } from "@/crm/retention-worker";

const NOW = new Date("2026-11-06T03:10:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.crmEmailThread.findMany.mockResolvedValue([]);
  db.crmNote.findMany.mockResolvedValue([]);
});

describe("retention rules", () => {
  it("is off when absent or corrupt, never a deletion by accident", () => {
    expect(readCrmRetention({})).toEqual(RETENTION_OFF);
    expect(readCrmRetention({ crmRetention: { emailMonths: 1, notesMonths: null } })).toEqual(RETENTION_OFF);
    expect(readCrmRetention({ crmRetention: { emailMonths: "24" } })).toEqual(RETENTION_OFF);
    expect(readCrmRetention({ crmRetention: { emailMonths: 24, notesMonths: null } })).toEqual({ emailMonths: 24, notesMonths: null });
  });

  it("only accepts whole months from 12 to 120", () => {
    expect(crmRetentionSchema.safeParse({ emailMonths: 11, notesMonths: null }).success).toBe(false);
    expect(crmRetentionSchema.safeParse({ emailMonths: 121, notesMonths: null }).success).toBe(false);
    expect(crmRetentionSchema.safeParse({ emailMonths: 12.5, notesMonths: null }).success).toBe(false);
    expect(crmRetentionSchema.safeParse({ emailMonths: 36, notesMonths: 120 }).success).toBe(true);
  });

  it("the cutoff is that many months back", () => {
    expect(retentionCutoff(24, NOW).toISOString()).toBe("2024-11-06T03:10:00.000Z");
  });
});

describe("runRetentionTick", () => {
  it("does nothing for an organisation with no period", async () => {
    db.organization.findMany.mockResolvedValue([{ id: "org-1", settings: {} }]);
    expect(await runRetentionTick(NOW)).toMatchObject({ organisations: 0 });
    expect(db.crmEmailThread.findMany).not.toHaveBeenCalled();
  });

  it("asks only organisations that have the CRM", async () => {
    db.organization.findMany.mockResolvedValue([]);
    await runRetentionTick(NOW);
    expect(db.organization.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { enabledModules: { has: "crm" } } }));
  });

  it("deletes threads older than the email period, audits it, then removes their files", async () => {
    db.organization.findMany.mockResolvedValue([{ id: "org-1", settings: { crmRetention: { emailMonths: 24, notesMonths: null } } }]);
    db.crmEmailThread.findMany.mockResolvedValue([{ id: "t-old", messages: [{ attachments: [{ path: "/uploads/crm-email-attachments/t-old/a.pdf" }] }] }]);
    const report = await runRetentionTick(NOW);
    expect(report).toMatchObject({ organisations: 1, emailThreads: 1, files: 1, failures: 0 });
    expect(db.crmEmailThread.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", lastMessageAt: { lt: new Date("2024-11-06T03:10:00Z") } } }));
    expect(db.crmNote.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "CRM_RETENTION_APPLIED", organizationId: "org-1" }) }));
    expect(remove).toHaveBeenCalledWith("emailAttachment", "/uploads/crm-email-attachments/t-old/a.pdf");
  });

  it("one organisation failing never stops the others", async () => {
    db.organization.findMany.mockResolvedValue([
      { id: "org-1", settings: { crmRetention: { emailMonths: 24, notesMonths: null } } },
      { id: "org-2", settings: { crmRetention: { emailMonths: null, notesMonths: 36 } } },
    ]);
    db.crmEmailThread.findMany.mockRejectedValueOnce(new Error("db blip"));
    db.crmNote.findMany.mockResolvedValue([{ id: "n-1" }]);
    db.crmNote.deleteMany.mockResolvedValue({ count: 1 });
    expect(await runRetentionTick(NOW)).toMatchObject({ organisations: 2, failures: 1, notes: 1 });
  });
});
