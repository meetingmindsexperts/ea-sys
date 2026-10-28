/**
 * Deal ↔ contacts — the many-to-many that makes a sponsorship deal realistic.
 *
 * A deal is not negotiated with one human: the rep who wants it, the marketing lead
 * who owns the budget, the procurement officer who can veto it. These tests pin that
 * the role lives on the LINK (so one person can be PRIMARY here, INFLUENCER there)
 * and that re-adding updates the role rather than erroring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => {
  const db = {
    crmDeal: { findFirst: vi.fn() },
    crmContact: { findFirst: vi.fn() },
    crmDealContact: { upsert: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
    // The deal-row lock inside the link transaction: a live deal by default.
    $queryRaw: vi.fn(),
  };
  return { db, tenantTransaction: (fn: (tx: typeof db) => unknown) => fn(db) };
});

import { db } from "@/lib/db";
import { addDealContact, removeDealContact } from "@/crm/services/deal-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ id: "d-1" }] as never);
});

describe("addDealContact", () => {
  it("refuses an archived contact (Oct 28, 2026)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: "e-1", archivedAt: null } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1", archivedAt: new Date() } as never);
    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1" });
    expect(res).toMatchObject({ ok: false, code: "CONTACT_ARCHIVED" });
    expect(db.crmDealContact.upsert).not.toHaveBeenCalled();
  });

  it("a contact archived after the check refuses the link (review LOW: both rows are locked)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: "e-1", archivedAt: null } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1", archivedAt: null } as never);
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([{ id: "d-1" }] as never).mockResolvedValueOnce([] as never);
    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1" });
    expect(res).toMatchObject({ ok: false, code: "CONTACT_ARCHIVED" });
    expect(db.crmDealContact.upsert).not.toHaveBeenCalled();
  });

  it("a deal archived after the check refuses the link (the row lock finds no live deal)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: "e-1", archivedAt: null } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1", archivedAt: null } as never);
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1" });
    expect(res).toMatchObject({ ok: false, code: "DEAL_ARCHIVED" });
    expect(db.crmDealContact.upsert).not.toHaveBeenCalled();
  });

  it("links a person with a role, binding BOTH ids to the org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: "e-1" } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1" } as never);
    vi.mocked(db.crmDealContact.upsert).mockResolvedValue({} as never);

    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1", role: "PROCUREMENT" });

    expect(res.ok).toBe(true);
    // Both lookups bind organizationId — the IDOR guard.
    expect(db.crmDeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d-1", organizationId: ORG } }),
    );
    expect(db.crmContact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cc-1", organizationId: ORG } }),
    );
    expect(db.crmDealContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // Multi-tenant prep: junction rows carry the org directly (RLS-readiness).
        create: expect.objectContaining({ role: "PROCUREMENT", organizationId: ORG }),
        update: expect.objectContaining({ role: "PROCUREMENT" }),
      }),
    );
  });

  it("is idempotent: re-adding UPDATES the role, never errors", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: null } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1" } as never);
    vi.mocked(db.crmDealContact.upsert).mockResolvedValue({} as never);

    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1", role: "MARKETING" });

    expect(res.ok).toBe(true);
    // upsert, not create — "actually Sarah is marketing" just works.
    expect(db.crmDealContact.upsert).toHaveBeenCalledOnce();
  });

  it("rejects a contact from another org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: null } as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue(null as never);

    const res = await addDealContact({ ...base, dealId: "d-1", crmContactId: "outsider" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("CONTACT_NOT_FOUND");
    expect(db.crmDealContact.upsert).not.toHaveBeenCalled();
  });

  it("rejects a deal from another org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    vi.mocked(db.crmContact.findFirst).mockResolvedValue({ id: "cc-1" } as never);

    const res = await addDealContact({ ...base, dealId: "someone-elses-deal", crmContactId: "cc-1" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("DEAL_NOT_FOUND");
  });
});

describe("removeDealContact", () => {
  it("detaches the person but does NOT delete them", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: null } as never);
    vi.mocked(db.crmDealContact.deleteMany).mockResolvedValue({ count: 1 } as never);

    const res = await removeDealContact({ ...base, dealId: "d-1", crmContactId: "cc-1" });

    expect(res.ok).toBe(true);
    // deleteMany targets the JOIN row only — the CrmContact is untouched.
    expect(db.crmDealContact.deleteMany).toHaveBeenCalledWith({
      where: { dealId: "d-1", crmContactId: "cc-1" },
    });
  });

  it("reports when the person wasn't on the deal", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", eventId: null } as never);
    vi.mocked(db.crmDealContact.deleteMany).mockResolvedValue({ count: 0 } as never);

    const res = await removeDealContact({ ...base, dealId: "d-1", crmContactId: "not-on-it" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("CONTACT_NOT_FOUND");
  });
});
