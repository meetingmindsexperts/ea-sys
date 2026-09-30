/**
 * `denyNonOrgAdmin` replaced 16 copies of `role !== "SUPER_ADMIN" && role !==
 * "ADMIN"` in the organisation settings routes (G7, docs/CUSTOM_ROLES_PLAN.md).
 * Behaviour-identical for every role that exists, and now logged. The table is
 * hand-written and the role list comes from the Prisma enum, so a new role
 * fails here until someone decides its answer (the G1 test's pattern).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserRole } from "@prisma/client";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { denyNonOrgAdmin } from "@/lib/auth-guards";

const IS_ORG_ADMIN: Record<UserRole, boolean> = {
  SUPER_ADMIN: true,
  ADMIN: true,
  ORGANIZER: false,
  MEMBER: false,
  REVIEWER: false,
  SUBMITTER: false,
  REGISTRANT: false,
  CRM_USER: false,
  ONSITE: false,
  WEBINARS: false,
  HR_USER: false,
};

beforeEach(() => mockWarn.mockClear());

describe("denyNonOrgAdmin", () => {
  it("covers every role in the Prisma enum", () => {
    for (const role of Object.values(UserRole)) expect(IS_ORG_ADMIN, `${role} missing`).toHaveProperty(role);
  });

  it.each(Object.values(UserRole))("%s gets the answer the copied line gave", (role) => {
    const res = denyNonOrgAdmin({ user: { id: "u", role } }, { route: "t" });
    expect(res === null).toBe(IS_ORG_ADMIN[role]);
    if (res) expect(res.status).toBe(403);
  });

  it("refuses a role-less caller (API key) and an unknown role, as the copied line did", () => {
    expect(denyNonOrgAdmin({ user: { id: "u" } }, { route: "t" })?.status).toBe(403);
    expect(denyNonOrgAdmin({ user: { id: "u", role: "CUSTOM" } }, { route: "t" })?.status).toBe(403);
    expect(denyNonOrgAdmin(null, { route: "t" })?.status).toBe(403);
  });

  it("logs every refusal with the route, and nothing when allowed", () => {
    denyNonOrgAdmin({ user: { id: "u1", role: "ORGANIZER" } }, { route: "organization/zoom/credentials:PUT" });
    expect(mockWarn).toHaveBeenCalledWith({
      msg: "auth-guard:org-admin-denied",
      role: "ORGANIZER",
      userId: "u1",
      route: "organization/zoom/credentials:PUT",
    });
    mockWarn.mockClear();
    denyNonOrgAdmin({ user: { id: "u2", role: "ADMIN" } }, { route: "x" });
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
