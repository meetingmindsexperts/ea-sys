/**
 * CRM visibility boundary.
 *
 * These tests are the security harness for the §9 decision-4 matrix. They exist
 * to make the three predicates' DISAGREEMENTS explicit and load-bearing — the
 * whole reason this file isn't just an alias for an existing guard is that the
 * CRM's role set matches none of them:
 *
 *                     read board   own/write   see money
 *   SUPER_ADMIN/ADMIN     ✓            ✓           ✓
 *   ORGANIZER             ✓            ✓           ✓
 *   MEMBER                ✓            ✗           ✗   ← the interesting row
 *   ONSITE                ✗            ✗           ✗
 *   REVIEWER/SUBMITTER    ✗            ✗           ✗
 *   REGISTRANT            ✗            ✗           ✗
 *   API key               ✓            ✓           ✓
 *
 * MEMBER is the row that must not drift: it is finance-capable elsewhere in
 * EA-SYS, and it is also the account we hand to sponsor-side stakeholders. If
 * someone "simplifies" canViewDealValues() into canViewFinance() one day, a
 * sponsor gets to read every rival's deal value — and these tests fail loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  canViewCrm,
  canOwnDeals,
  canViewDealValues,
  canPurgeCrm,
  canExportCrm,
  denyCrmAccess,
  denyCrmWrite,
  denyCrmPurge,
  denyCrmExport,
} from "@/crm/lib/crm-visibility";
import { apiLogger } from "@/lib/logger";

const STAFF = ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] as const;
const BLOCKED = ["ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT"] as const;

const ctx = (role: string | null, fromApiKey = false) => ({
  role,
  userId: role ? `u-${role}` : null,
  fromApiKey,
});

beforeEach(() => vi.clearAllMocks());

describe("canViewCrm — who may READ the board", () => {
  it.each(STAFF)("allows staff role %s", (role) => {
    expect(canViewCrm(role)).toBe(true);
  });

  it("allows MEMBER — leadership is exactly who wants the board", () => {
    expect(canViewCrm("MEMBER")).toBe(true);
  });

  it.each(BLOCKED)("blocks %s", (role) => {
    expect(canViewCrm(role)).toBe(false);
  });

  it("blocks ONSITE even though FINANCE_ROLES includes it", () => {
    // The trap: ONSITE is finance-capable, so a naive canViewFinance() reuse
    // would hand a desk temp the sponsorship pipeline.
    expect(canViewCrm("ONSITE")).toBe(false);
  });

  it("treats API keys as admin-equivalent", () => {
    expect(canViewCrm(null, true)).toBe(true);
  });

  it("fails closed on null / undefined / unknown roles", () => {
    expect(canViewCrm(null)).toBe(false);
    expect(canViewCrm(undefined)).toBe(false);
    expect(canViewCrm("FUTURE_ROLE_NOBODY_ADDED_HERE")).toBe(false);
  });
});

describe("canOwnDeals — who may WRITE / own", () => {
  it.each(STAFF)("allows staff role %s", (role) => {
    expect(canOwnDeals(role)).toBe(true);
  });

  it("BLOCKS MEMBER — it can see the board but never move a card", () => {
    expect(canOwnDeals("MEMBER")).toBe(false);
  });

  it.each(BLOCKED)("blocks %s", (role) => {
    expect(canOwnDeals(role)).toBe(false);
  });

  it("fails closed", () => {
    expect(canOwnDeals(null)).toBe(false);
    expect(canOwnDeals(undefined)).toBe(false);
  });
});

describe("canViewDealValues — who sees the money", () => {
  it.each(STAFF)("allows staff role %s", (role) => {
    expect(canViewDealValues(role)).toBe(true);
  });

  it("BLOCKS MEMBER — a sponsor-side MEMBER must not read rival deal values", () => {
    // This is the single most important assertion in the file. MEMBER *is*
    // finance-capable elsewhere (FINANCE_ROLES includes it); the CRM
    // deliberately narrows that. Do not "fix" this by reusing canViewFinance().
    expect(canViewDealValues("MEMBER")).toBe(false);
  });

  it("is strictly narrower than the read predicate", () => {
    // Every role that can see values can read the board, but not vice versa.
    const roles = [...STAFF, "MEMBER", ...BLOCKED];
    for (const r of roles) {
      if (canViewDealValues(r)) expect(canViewCrm(r)).toBe(true);
    }
    // …and at least one role differentiates them, else the two are redundant.
    expect(canViewCrm("MEMBER") && !canViewDealValues("MEMBER")).toBe(true);
  });
});

describe("denyCrmAccess", () => {
  it("returns null for a permitted role", () => {
    expect(denyCrmAccess(ctx("ORGANIZER"))).toBeNull();
    expect(denyCrmAccess(ctx("MEMBER"))).toBeNull();
  });

  it("403s a blocked role with a machine-readable code", async () => {
    const res = denyCrmAccess(ctx("ONSITE"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code: "CRM_FORBIDDEN" });
  });

  it("LOGS its own refusal so no call site can forget to", () => {
    denyCrmAccess(ctx("REGISTRANT"));
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "auth-guard:crm-read-denied", role: "REGISTRANT" }),
    );
  });

  it("does not log when access is granted", () => {
    denyCrmAccess(ctx("ADMIN"));
    expect(apiLogger.warn).not.toHaveBeenCalled();
  });
});

describe("denyCrmWrite", () => {
  it("returns null for staff", () => {
    expect(denyCrmWrite(ctx("ADMIN"))).toBeNull();
  });

  it("403s MEMBER — the read-only role cannot write", async () => {
    const res = denyCrmWrite(ctx("MEMBER"));
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code: "CRM_WRITE_FORBIDDEN" });
  });

  it("logs the refusal", () => {
    denyCrmWrite(ctx("MEMBER"));
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "auth-guard:crm-write-denied", role: "MEMBER" }),
    );
  });
});


// ── Purge (SUPER_ADMIN-only permanent delete) ────────────────────────────────

describe("canPurgeCrm — the narrowest predicate, and the one that refuses API keys", () => {
  it("allows ONLY a SUPER_ADMIN session", () => {
    expect(canPurgeCrm("SUPER_ADMIN")).toBe(true);
  });

  it("blocks ADMIN, ORGANIZER, CRM_USER, MEMBER — everyone who may archive but not purge", () => {
    for (const r of ["ADMIN", "ORGANIZER", "CRM_USER", "MEMBER", "ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT"]) {
      expect(canPurgeCrm(r)).toBe(false);
    }
  });

  it("REFUSES an API key even though every OTHER CRM predicate treats it as admin — destruction of revenue history is a human decision", () => {
    expect(canPurgeCrm(null, true)).toBe(false);
    expect(canPurgeCrm("SUPER_ADMIN", true)).toBe(false); // the isApiKey flag wins
  });

  it("fails closed on unknown / absent role", () => {
    expect(canPurgeCrm(null)).toBe(false);
    expect(canPurgeCrm(undefined)).toBe(false);
    expect(canPurgeCrm("WHATEVER")).toBe(false);
  });
});

describe("denyCrmPurge", () => {
  it("returns null for a SUPER_ADMIN session", () => {
    expect(denyCrmPurge(ctx("SUPER_ADMIN"))).toBeNull();
  });

  it("403s everyone else (ADMIN included) with CRM_PURGE_FORBIDDEN", async () => {
    const res = denyCrmPurge(ctx("ADMIN"));
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code: "CRM_PURGE_FORBIDDEN" });
  });

  it("403s an API-key caller", async () => {
    const res = denyCrmPurge({ role: null, userId: null, fromApiKey: true });
    expect(res!.status).toBe(403);
  });

  it("logs its own refusal", () => {
    denyCrmPurge(ctx("ADMIN"));
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "auth-guard:crm-purge-denied", role: "ADMIN" }),
    );
  });
});

/**
 * EXPORT — admin and above (owner decision, August 7 2026).
 *
 * This is the module's NARROWEST read boundary, and the only one that is tighter
 * than WRITE. The rows that matter and must not drift:
 *
 *   CRM_USER  — works the pipeline daily, may edit and ARCHIVE records, and is
 *               still refused the bulk dump. A rep leaving for a competitor with
 *               a CSV of the whole book is the exact loss this exists to stop.
 *   ORGANIZER — may write, may not export.
 *   MEMBER    — reads the board, may not export.
 *
 * If someone ever "simplifies" canExportCrm() into canViewCrm() or canOwnDeals(),
 * every one of those three gets the book and these tests fail loudly.
 */
describe("canExportCrm", () => {
  it("allows SUPER_ADMIN and ADMIN", () => {
    expect(canExportCrm("SUPER_ADMIN")).toBe(true);
    expect(canExportCrm("ADMIN")).toBe(true);
  });

  it("REFUSES CRM_USER — the row that makes this narrower than WRITE, not just than READ", () => {
    // Deliberately paired: a rep who can archive a record still cannot dump the book.
    expect(canOwnDeals("CRM_USER")).toBe(true);
    expect(canExportCrm("CRM_USER")).toBe(false);
  });

  it("REFUSES ORGANIZER — writes the pipeline, does not export it", () => {
    expect(canOwnDeals("ORGANIZER")).toBe(true);
    expect(canExportCrm("ORGANIZER")).toBe(false);
  });

  it("REFUSES MEMBER — reads the board, does not export it", () => {
    expect(canViewCrm("MEMBER")).toBe(true);
    expect(canExportCrm("MEMBER")).toBe(false);
  });

  it("refuses every non-CRM role", () => {
    for (const r of ["ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "WEBINARS"]) {
      expect(canExportCrm(r)).toBe(false);
    }
  });

  it("ALLOWS an API key — unlike canPurgeCrm, because the MCP read tools already serve the same rows", () => {
    // If this ever flips, the MCP surface has to move in the same commit or the
    // boundary is theatre: list_crm_deals would still answer a valid key.
    expect(canExportCrm(null, true)).toBe(true);
    expect(canPurgeCrm(null, true)).toBe(false); // the contrast is the point
  });

  it("fails closed on unknown / absent role", () => {
    expect(canExportCrm(null)).toBe(false);
    expect(canExportCrm(undefined)).toBe(false);
    expect(canExportCrm("WHATEVER")).toBe(false);
  });
});

describe("denyCrmExport", () => {
  it("returns null for an ADMIN session", () => {
    expect(denyCrmExport(ctx("ADMIN"))).toBeNull();
  });

  it("403s CRM_USER with CRM_EXPORT_FORBIDDEN", async () => {
    const res = denyCrmExport(ctx("CRM_USER"));
    expect(res!.status).toBe(403);
    await expect(res!.json()).resolves.toMatchObject({ code: "CRM_EXPORT_FORBIDDEN" });
  });

  it("403s ORGANIZER and MEMBER", () => {
    expect(denyCrmExport(ctx("ORGANIZER"))!.status).toBe(403);
    expect(denyCrmExport(ctx("MEMBER"))!.status).toBe(403);
  });

  it("allows an API-key caller", () => {
    expect(denyCrmExport({ role: null, userId: null, fromApiKey: true })).toBeNull();
  });

  it("logs its own refusal", () => {
    denyCrmExport(ctx("CRM_USER"));
    expect(apiLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "auth-guard:crm-export-denied", role: "CRM_USER" }),
    );
  });
});
