/**
 * CRM soft-delete (archive) + the change log.
 *
 * Pins the three things that are easy to get wrong:
 *   1. WHO may archive — admin tier + CRM_USER, but NOT ORGANIZER (who may edit).
 *   2. The default list view EXCLUDES archived; reports never see a dead deal.
 *   3. `diffFields` records real before→after values (Decimals as numbers, Dates as
 *      ISO), and returns null for a no-op edit so the log isn't spammed.
 * Plus that archiving is idempotent (a double-click records nothing twice).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db", () => ({
  db: {
    crmDeal: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    crmPipelineStage: { findFirst: vi.fn() },
    crmCompany: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    crmActivity: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import { isArchivedView, buildDealWhere } from "@/crm/lib/deal-filters";
import { diffFields } from "@/crm/lib/crm-activity";
import { setDealArchived } from "@/crm/services/deal-service";

const ORG = "org-1";
const base = { organizationId: ORG, userId: "u-1", source: "rest" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.crmActivity.create).mockResolvedValue({} as never);
});

// ── Who may archive ────────────────────────────────────────────────────────────

describe("canDeleteCrm", () => {
  it("allows the admin tier + CRM_USER", () => {
    for (const r of ["SUPER_ADMIN", "ADMIN", "CRM_USER"]) {
      expect(canDeleteCrm(r)).toBe(true);
    }
  });

  it("blocks ORGANIZER (may edit, not archive) + MEMBER + desk/attendee roles", () => {
    for (const r of ["ORGANIZER", "MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canDeleteCrm(r)).toBe(false);
    }
  });

  it("fails closed on unknown / absent role, and treats an API key as admin", () => {
    expect(canDeleteCrm(null)).toBe(false);
    expect(canDeleteCrm(undefined)).toBe(false);
    expect(canDeleteCrm("WHATEVER")).toBe(false);
    expect(canDeleteCrm(null, true)).toBe(true); // isApiKey
  });
});

// ── Archived view / list filtering ──────────────────────────────────────────────

describe("isArchivedView", () => {
  it("is true only for the explicit archived flags", () => {
    expect(isArchivedView("1")).toBe(true);
    expect(isArchivedView("true")).toBe(true);
    expect(isArchivedView("0")).toBe(false);
    expect(isArchivedView(null)).toBe(false);
    expect(isArchivedView(undefined)).toBe(false);
    expect(isArchivedView("")).toBe(false);
  });
});

describe("buildDealWhere — archived filtering", () => {
  it("excludes archived deals by default (the active view + reports/export)", () => {
    const where = buildDealWhere({}, { organizationId: ORG, canSeeValues: true });
    expect(where.archivedAt).toBeNull();
  });

  it("shows ONLY archived deals in the archived view", () => {
    const where = buildDealWhere({ archived: "1" }, { organizationId: ORG, canSeeValues: true });
    expect(where.archivedAt).toEqual({ not: null });
  });

  it("a report (no archived param) never counts a dead deal", () => {
    // Reports call buildDealWhere without `archived`, so archivedAt is null → active only.
    const where = buildDealWhere({ status: "WON" }, { organizationId: ORG, canSeeValues: true });
    expect(where.archivedAt).toBeNull();
  });
});

// ── Field diffing ───────────────────────────────────────────────────────────────

describe("diffFields", () => {
  it("records only changed fields, with before→after values", () => {
    const before = { name: "A", currency: "USD" };
    const after = { name: "B", currency: "USD" };
    expect(diffFields(before, after, ["name", "currency"] as const)).toEqual({
      name: { from: "A", to: "B" },
    });
  });

  it("returns null when nothing changed (so a no-op edit records nothing)", () => {
    const row = { name: "A", currency: "USD" };
    expect(diffFields(row, { ...row }, ["name", "currency"] as const)).toBeNull();
  });

  it("normalizes Decimal → number and Date → ISO", () => {
    const before = { dealValue: new Prisma.Decimal(1000), expectedClose: new Date("2026-01-01T00:00:00.000Z") };
    const after = { dealValue: new Prisma.Decimal(2000), expectedClose: new Date("2026-02-01T00:00:00.000Z") };
    const d = diffFields(before, after, ["dealValue", "expectedClose"] as const);
    expect(d).toEqual({
      dealValue: { from: 1000, to: 2000 },
      expectedClose: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
    });
  });

  it("treats null and undefined as the same (no phantom change)", () => {
    const d = diffFields({ notes: null }, { notes: undefined }, ["notes"] as const);
    expect(d).toBeNull();
  });
});

// ── Archive idempotency + the log entry ─────────────────────────────────────────

describe("setDealArchived", () => {
  it("archives an active deal via a CONDITIONAL CLAIM (R2-M2), and records ONE ARCHIVE entry", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", archivedAt: null } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", name: "Abbott", dealValue: null, currency: "USD", archivedAt: new Date() } as never);

    const res = await setDealArchived({ ...base, dealId: "d-1", archived: true });

    expect(res.ok).toBe(true);
    // The write is a claim: it only lands if the row is still un-archived. This
    // is what makes two concurrent archives record ARCHIVE once, not twice.
    const claim = vi.mocked(db.crmDeal.updateMany).mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "d-1", organizationId: ORG, archivedAt: null });
    expect(db.crmActivity.create).toHaveBeenCalledOnce();
    expect(vi.mocked(db.crmActivity.create).mock.calls[0][0].data.action).toBe("ARCHIVE");
  });

  it("the claim LOSER (already archived, or a concurrent double-archive) is an idempotent no-op — no log entry", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", archivedAt: new Date() } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await setDealArchived({ ...base, dealId: "d-1", archived: true });

    expect(res.ok).toBe(true);
    expect(db.crmActivity.create).not.toHaveBeenCalled();
  });

  it("returns DEAL_NOT_FOUND for a deal that isn't in the caller's org", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue(null as never);
    const res = await setDealArchived({ ...base, dealId: "nope", archived: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("DEAL_NOT_FOUND");
  });

  it("records a RESTORE entry when un-archiving (claim requires archivedAt NOT null)", async () => {
    vi.mocked(db.crmDeal.findFirst).mockResolvedValue({ id: "d-1", archivedAt: new Date() } as never);
    vi.mocked(db.crmDeal.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.crmDeal.findUniqueOrThrow).mockResolvedValue({ id: "d-1", name: "Abbott", dealValue: null, currency: "USD", archivedAt: null } as never);

    await setDealArchived({ ...base, dealId: "d-1", archived: false });

    const claim = vi.mocked(db.crmDeal.updateMany).mock.calls[0][0];
    expect(claim.where).toMatchObject({ archivedAt: { not: null } });
    expect(vi.mocked(db.crmActivity.create).mock.calls[0][0].data.action).toBe("RESTORE");
  });
});
