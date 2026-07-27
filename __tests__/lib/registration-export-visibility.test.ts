/**
 * The registrations-export boundary.
 *
 * Export is deliberately NARROWER than read: a MEMBER may page through the list
 * on screen but may not take the whole attendee book away as one file. Before
 * this predicate the export authorized on `getOrgContext` alone, so MEMBER
 * (leadership / sponsor-side per the RBAC docs) and an internal-domain
 * REGISTRANT could both one-click it.
 *
 * These tests pin the role set explicitly rather than deriving it, so widening
 * the boundary requires editing a test that says why the boundary exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: mockLogger }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import {
  canExportRegistrations,
  denyRegistrationExport,
} from "@/lib/registration-export-visibility";

beforeEach(() => vi.clearAllMocks());

describe("canExportRegistrations", () => {
  it("allows the roles that run the event and the desk", () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "ONSITE"]) {
      expect(canExportRegistrations(role), role).toBe(true);
    }
  });

  // The whole point of the predicate.
  it("refuses MEMBER — read-only leadership / sponsor-side must not take the book", () => {
    expect(canExportRegistrations("MEMBER")).toBe(false);
  });

  it("refuses an internal-domain REGISTRANT (org-bound, but still a registrant)", () => {
    expect(canExportRegistrations("REGISTRANT")).toBe(false);
  });

  it("refuses REVIEWER, SUBMITTER and CRM_USER", () => {
    for (const role of ["REVIEWER", "SUBMITTER", "CRM_USER"]) {
      expect(canExportRegistrations(role), role).toBe(false);
    }
  });

  it("allows API-key callers (admin-equivalent, org-scoped, admin-minted)", () => {
    expect(canExportRegistrations(null, true)).toBe(true);
  });

  it("fails closed on an absent or unknown role", () => {
    expect(canExportRegistrations(null)).toBe(false);
    expect(canExportRegistrations(undefined)).toBe(false);
    expect(canExportRegistrations("FUTURE_ROLE")).toBe(false);
  });

  // Guards against someone "simplifying" this to canViewFinance / canViewEntryBarcode.
  it("is NOT the finance boundary — finance includes MEMBER, this must not", () => {
    expect(canExportRegistrations("MEMBER")).toBe(false);
  });
});

describe("denyRegistrationExport", () => {
  it("returns null for a permitted caller", () => {
    expect(denyRegistrationExport({ role: "ORGANIZER" })).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("403s with a machine-readable code for a refused caller", async () => {
    const res = denyRegistrationExport({ role: "MEMBER", eventId: "evt_1", userId: "u1" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect((await res!.json()) as { code: string }).toMatchObject({ code: "EXPORT_FORBIDDEN" });
  });

  // "Every failure path logs" — a silent 403 on a PII boundary is what we
  // don't want to be blind to, and logging inside the guard means no call site
  // can forget.
  it("logs its own refusal with the role and scope", () => {
    denyRegistrationExport({
      role: "REGISTRANT",
      userId: "u9",
      organizationId: "org_1",
      eventId: "evt_2",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: "registrations-export:forbidden",
        role: "REGISTRANT",
        userId: "u9",
        eventId: "evt_2",
      }),
    );
  });
});
