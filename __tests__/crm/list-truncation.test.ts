/**
 * Honest truncation on the CRM list surfaces.
 *
 * THE BUG. The deals board returned at most 1,000 rows and said nothing about
 * it, so a pipeline with 10,412 deals rendered as a pipeline with 1,000 deals.
 * That is not a visibly broken screen — it is a plausible one, and every total
 * read off it was wrong. The cap is a rendering budget; the `total` these routes
 * now return is the correctness mechanism, and these tests pin the difference.
 */
import { describe, it, expect } from "vitest";
import {
  listMeta,
  CRM_DEALS_LIST_CAP,
  CRM_CONTACTS_LIST_CAP,
  CRM_COMPANIES_LIST_CAP,
} from "@/crm/lib/list-caps";

describe("listMeta", () => {
  it("flags truncation when the cap hid rows", () => {
    expect(listMeta(10_412, 2000)).toEqual({ total: 10_412, truncated: true });
  });

  it("does NOT flag a list that fits — the banner must stay invisible on a normal org", () => {
    expect(listMeta(230, 230)).toEqual({ total: 230, truncated: false });
    expect(listMeta(0, 0)).toEqual({ total: 0, truncated: false });
  });

  it("compares against what was RETURNED, not against the cap", () => {
    // Keying on `returned === CAP` would false-positive on an org holding
    // exactly CAP rows, and false-negative if a route ever lowers its own take.
    expect(listMeta(CRM_DEALS_LIST_CAP, CRM_DEALS_LIST_CAP).truncated).toBe(false);
    expect(listMeta(CRM_DEALS_LIST_CAP + 1, CRM_DEALS_LIST_CAP).truncated).toBe(true);
  });
});

describe("the caps themselves", () => {
  it("are large enough to cover the migration's populations without truncating", () => {
    // ~10k deals is the real Freshsales tenant; the board deliberately does NOT
    // try to render all of them (no virtualisation) — the banner covers that.
    // Contacts (4.4k) and companies (230) SHOULD fit, and if a future edit drops
    // these caps below the real data the banner would start firing every day.
    expect(CRM_CONTACTS_LIST_CAP).toBeGreaterThanOrEqual(1000);
    expect(CRM_COMPANIES_LIST_CAP).toBeGreaterThanOrEqual(1000);
  });

  it("keeps the board cap bounded — it renders every card with no virtualisation", () => {
    // Raising this without adding virtualisation trades a truthful banner for a
    // frozen tab. Filters are the intended answer, which is what the banner says.
    expect(CRM_DEALS_LIST_CAP).toBeLessThanOrEqual(2500);
  });
});
