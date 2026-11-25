/**
 * Who may be told about an email in the CRM inbox (review of 62a2ee7a0, Nov 25,
 * 2026): a member of the organisation, not deactivated, holding crm.read and
 * crm.inbox.read from the base role or a custom role. Owning the record is not it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { user: { findFirst: vi.fn() }, userPermissionSet: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { inboxNoticeRefusal } from "@/crm/services/crm-inbox-notice-eligibility";

const role = (...keys: string[]) => [{ permissionSet: { permissions: keys.map((permission) => ({ permission, scope: null })) } }];

describe("inboxNoticeRefusal", () => {
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

  it("tells the base roles that hold the inbox, without reading custom roles", async () => {
    for (const r of ["SUPER_ADMIN", "ADMIN", "CRM_USER"]) {
      mockDb.user.findFirst.mockResolvedValueOnce({ id: "u", role: r, deactivatedAt: null });
      expect(await inboxNoticeRefusal("o", "u")).toBeNull();
    }
    expect(mockDb.userPermissionSet.findMany).not.toHaveBeenCalled();
  });

  it("looks the person up inside this organisation only", async () => {
    mockDb.user.findFirst.mockResolvedValue(null);
    expect(await inboxNoticeRefusal("org-1", "u-other")).toBe("not-in-organisation");
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u-other", organizationId: "org-1" } }));
  });

  it("refuses a deactivated person, whatever their role", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u", role: "ADMIN", deactivatedAt: new Date("2026-11-01") });
    expect(await inboxNoticeRefusal("o", "u")).toBe("deactivated");
  });

  it("refuses an Organizer with no custom role (no CRM since Oct 7, 2026)", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u", role: "ORGANIZER", deactivatedAt: null });
    expect(await inboxNoticeRefusal("o", "u")).toBe("no-inbox-access");
  });

  it("refuses a custom role that gives the CRM but leaves the inbox out", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u", role: "BASE", deactivatedAt: null });
    mockDb.userPermissionSet.findMany.mockResolvedValue(role("crm.read", "crm.write"));
    expect(await inboxNoticeRefusal("o", "u")).toBe("no-inbox-access");
  });

  it("tells a custom role that gives both the CRM and its inbox", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u", role: "BASE", deactivatedAt: null });
    mockDb.userPermissionSet.findMany.mockResolvedValue(role("crm.read", "crm.inbox.read"));
    expect(await inboxNoticeRefusal("o", "u")).toBeNull();
  });
});
