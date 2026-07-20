/**
 * CRM purge service — the SUPER_ADMIN permanent-delete exception.
 *
 * The rules that keep the one hard-delete path in the module safe, pinned:
 *   1. ARCHIVED ONLY — an active record is never purgeable (NOT_ARCHIVED).
 *   2. Every purge leaves an AuditLog snapshot — after the delete it is the only
 *      record the row existed.
 *   3. A company still referenced by deals is refused (COMPANY_HAS_DEALS) — the
 *      FK is Restrict; we surface a friendly message, not a raw P2003.
 *   4. Bulk runs deals → companies → contacts so a company whose only deals were
 *      just purged becomes deletable in the same pass; per-record refusals are
 *      REPORTED, never a silent skip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: { findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    crmCompany: { findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    crmContact: { findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    crmActivity: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
}));

import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { purgeDeal, purgeCompany, purgeCrmContact, purgeArchived } from "@/crm/services/crm-purge-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-super" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  // The tx runs the batched writes; forward to the mocked delegates.
  vi.mocked(db.$transaction).mockResolvedValue([] as never);
});

const dealRow = (over: Record<string, unknown> = {}) => ({
  id: "d-1", name: "Abbott — Gold", status: "LOST", dealValue: null, currency: "USD",
  eventId: "e-1", companyId: "c-1", ownerId: null, archivedAt: new Date(),
  _count: { contacts: 2, products: 1, notes: 3, tasks: 1 }, ...over,
});

describe("purgeDeal", () => {
  it("refuses an ACTIVE deal — purge is archived-only", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(dealRow({ archivedAt: null }) as never);
    const res = await purgeDeal({ ...base, dealId: "d-1" });
    expect(res).toMatchObject({ ok: false, code: "NOT_ARCHIVED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("404s a deal not in the caller's org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    expect(await purgeDeal({ ...base, dealId: "nope" })).toMatchObject({ ok: false, code: "DEAL_NOT_FOUND" });
  });

  it("deletes an archived deal (its History too) and snapshots it to the audit log", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(dealRow() as never);
    const res = await purgeDeal({ ...base, dealId: "d-1" });
    expect(res.ok).toBe(true);
    expect(db.$transaction).toHaveBeenCalledOnce();
    const audit = vi.mocked(db.auditLog.create).mock.calls[0]![0].data as { action: string; entityType: string; changes: Record<string, unknown> };
    expect(audit.action).toBe("CRM_PURGE");
    expect(audit.entityType).toBe("CrmDeal");
    expect(audit.changes.name).toBe("Abbott — Gold");
    expect(audit.changes.cascaded).toMatchObject({ contacts: 2, products: 1 });
  });
});

describe("purgeCompany — the Restrict guard", () => {
  const companyRow = (over: Record<string, unknown> = {}) => ({
    id: "c-1", name: "Abbott", industry: null, website: null, country: null, city: null,
    archivedAt: new Date(), _count: { deals: 0, contacts: 4, notes_: 2, tasks: 1 }, ...over,
  });

  it("refuses an active company", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(companyRow({ archivedAt: null }) as never);
    expect(await purgeCompany({ ...base, companyId: "c-1" })).toMatchObject({ ok: false, code: "NOT_ARCHIVED" });
  });

  it("refuses a company still referenced by ANY deal (the FK is Restrict) — a friendly COMPANY_HAS_DEALS, not a raw P2003", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(companyRow({ _count: { deals: 3, contacts: 0, notes_: 0, tasks: 0 } }) as never);
    const res = await purgeCompany({ ...base, companyId: "c-1" });
    expect(res).toMatchObject({ ok: false, code: "COMPANY_HAS_DEALS", meta: { dealCount: 3 } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("deletes an archived company with no deals + snapshots it", async () => {
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue(companyRow() as never);
    const res = await purgeCompany({ ...base, companyId: "c-1" });
    expect(res.ok).toBe(true);
    const audit = vi.mocked(db.auditLog.create).mock.calls[0]![0].data as { entityType: string; changes: Record<string, unknown> };
    expect(audit.entityType).toBe("CrmCompany");
    expect(audit.changes.cascaded).toMatchObject({ contactsUnlinked: 4 });
  });
});

describe("purgeCrmContact", () => {
  const contactRow = (over: Record<string, unknown> = {}) => ({
    id: "ct-1", firstName: "Sara", lastName: "Khan", emailKey: "sara@abbott.com", companyId: "c-1",
    archivedAt: new Date(), _count: { deals: 2, crmNotes: 1, tasks: 0 }, ...over,
  });

  it("refuses an active contact", async () => {
    vi.mocked(db.crmContact.findFirst).mockResolvedValue(contactRow({ archivedAt: null }) as never);
    expect(await purgeCrmContact({ ...base, crmContactId: "ct-1" })).toMatchObject({ ok: false, code: "NOT_ARCHIVED" });
  });

  it("deletes an archived contact (cascading its deal links) + snapshots it", async () => {
    vi.mocked(db.crmContact.findFirst).mockResolvedValue(contactRow() as never);
    const res = await purgeCrmContact({ ...base, crmContactId: "ct-1" });
    expect(res.ok).toBe(true);
    const audit = vi.mocked(db.auditLog.create).mock.calls[0]![0].data as { entityType: string; changes: Record<string, unknown> };
    expect(audit.entityType).toBe("CrmContact");
    expect(audit.changes.cascaded).toMatchObject({ dealLinks: 2 });
  });
});

describe("purgeArchived — bulk", () => {
  it("purges deals THEN companies THEN contacts, and REPORTS per-record refusals", async () => {
    // One archived deal (purgeable) + one archived company still holding a deal
    // (refused) + one archived contact (purgeable).
    vi.mocked(db.crmDeal.findMany).mockResolvedValue([{ id: "d-1", name: "Abbott — Gold" }] as never);
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(dealRow() as never);

    vi.mocked(db.crmCompany.findMany).mockResolvedValue([{ id: "c-1", name: "Pfizer" }] as never);
    vi.mocked(db.crmCompany.findFirst).mockResolvedValue({
      id: "c-1", name: "Pfizer", industry: null, website: null, country: null, city: null,
      archivedAt: new Date(), _count: { deals: 2, contacts: 0, notes_: 0, tasks: 0 },
    } as never);

    vi.mocked(db.crmContact.findMany).mockResolvedValue([{ id: "ct-1", firstName: "Sara", lastName: "Khan" }] as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({
      id: "ct-1", firstName: "Sara", lastName: "Khan", emailKey: "s@x.com", companyId: null,
      archivedAt: new Date(), _count: { deals: 0, crmNotes: 0, tasks: 0 },
    } as never);

    const res = await purgeArchived({ ...base, entity: "all" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.purged).toMatchObject({ deals: 1, companies: 0, contacts: 1 });
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ entity: "company", reason: expect.stringMatching(/still reference/) });
    expect(res.capped).toBe(false);
  });

  it("scoped to one entity only touches that kind", async () => {
    vi.mocked(db.crmContact.findMany).mockResolvedValue([] as never);
    const res = await purgeArchived({ ...base, entity: "contacts" });
    if (!res.ok) throw new Error("unreachable");
    expect(db.crmDeal.findMany).not.toHaveBeenCalled();
    expect(db.crmCompany.findMany).not.toHaveBeenCalled();
    expect(res.purged).toEqual({ deals: 0, companies: 0, contacts: 0 });
  });

  it("flags `capped: true` when the per-entity ceiling binds — no silent truncation", async () => {
    // 501 rows > the 500 cap.
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `d-${i}`, name: `Deal ${i}` }));
    vi.mocked(db.crmDeal.findMany).mockResolvedValue(many as never);
    vi.mocked(db.crmDeal.findFirst).mockImplementation((async () => dealRow()) as never);

    const res = await purgeArchived({ ...base, entity: "deals" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.capped).toBe(true);
    expect(res.purged.deals).toBe(500); // exactly the cap, not 501
    expect(apiLogger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: "crm-purge:bulk-done", capped: true }));
  });
});
