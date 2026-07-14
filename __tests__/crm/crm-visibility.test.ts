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
  denyCrmAccess,
  denyCrmWrite,
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
