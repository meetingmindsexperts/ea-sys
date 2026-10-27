/**
 * nameReferences(): History shows names, not ids, for owner and account changes
 * (owner, Oct 27 2026), resolved at read time and org-scoped.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findMany: vi.fn().mockResolvedValue([{ id: "u-1", firstName: "Sohail", lastName: "Qureshi" }]) },
    crmCompany: { findMany: vi.fn().mockResolvedValue([{ id: "co-1", name: "Abbott" }]) },
  },
}));

import { db } from "@/lib/db";
import { nameReferences } from "@/crm/lib/crm-activity";

describe("nameReferences", () => {
  it("replaces owner and account ids with names and leaves everything else alone", async () => {
    const rows = [
      { id: "a", changes: { source: "rest", changes: { ownerId: { from: null, to: "u-1" }, city: { from: "A", to: "B" } } } },
      { id: "b", changes: { source: "rest", changes: { companyId: { from: "co-gone", to: "co-1" } } } },
      { id: "c", changes: { source: "freshsales-owners", changes: { ownerId: { from: null, to: "Saleh Mahmoud" } } } },
      { id: "d", changes: { source: "rest", name: "Abbott" } },
    ];
    const out = await nameReferences("org-1", rows);
    expect(out[0]!.changes).toEqual({
      source: "rest",
      changes: { ownerId: { from: null, to: "Sohail Qureshi" }, city: { from: "A", to: "B" } },
    });
    // A purged account keeps its id; a known one gets its name.
    expect((out[1]!.changes as { changes: unknown }).changes).toEqual({ companyId: { from: "co-gone", to: "Abbott" } });
    // Already a name (the backfill scripts store names): untouched.
    expect(out[2]).toEqual(rows[2]);
    expect(out[3]).toBe(rows[3]);
    // Org-scoped lookups.
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1" }) }));
    expect(db.crmCompany.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1" }) }));
  });

  it("makes no query when no row references an owner or account", async () => {
    vi.mocked(db.user.findMany).mockClear();
    const rows = [{ id: "a", changes: { changes: { city: { from: "A", to: "B" } } } }];
    expect(await nameReferences("org-1", rows)).toBe(rows);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
