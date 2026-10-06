/**
 * Who may OWN a CRM record (custom roles Phase 6, Oct 6, 2026): `crm.write`
 * from the base role, or from a custom role the person holds. It was
 * `canOwnDeals(role)`, which a custom role could not reach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({ mockDb: { userPermissionSet: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { mayOwnCrmRecords } from "@/crm/services/crm-owner-eligibility";

const crmWriteRole = [{ permissionSet: { permissions: [{ permission: "crm.write", scope: null }] } }];

describe("mayOwnCrmRecords", () => {
  const prev = process.env.CUSTOM_ROLES_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CUSTOM_ROLES_ENABLED = "true";
    mockDb.userPermissionSet.findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CUSTOM_ROLES_ENABLED;
    else process.env.CUSTOM_ROLES_ENABLED = prev;
  });

  it("admits the CRM-capable base roles without reading custom roles", async () => {
    for (const role of ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "CRM_USER"]) {
      expect(await mayOwnCrmRecords("o", { id: "u", role })).toBe(true);
    }
    expect(mockDb.userPermissionSet.findMany).not.toHaveBeenCalled();
  });

  it("refuses a Member, Onsite or Webinars user with no custom role", async () => {
    for (const role of ["MEMBER", "ONSITE", "WEBINARS"]) {
      expect(await mayOwnCrmRecords("o", { id: "u", role })).toBe(false);
    }
  });

  it("admits a Member whose custom role grants crm.write", async () => {
    mockDb.userPermissionSet.findMany.mockResolvedValue(crmWriteRole);
    expect(await mayOwnCrmRecords("o", { id: "u", role: "MEMBER" })).toBe(true);
  });
});
