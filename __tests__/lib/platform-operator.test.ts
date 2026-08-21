/**
 * The platform-operator RBAC wall (multi-tenancy item 5).
 *
 * The truth table matters more than usual here because this predicate is the
 * ONLY thing standing between a role and cross-tenant reads. Two properties
 * are asserted deliberately rather than left to reading:
 *
 *  - EVERY non-SUPER_ADMIN role is refused, enumerated explicitly. A role
 *    added to the platform later inherits refusal by default; if someone
 *    wants it admitted, they have to come here and say so.
 *
 *  - AN ORG API KEY IS REFUSED. Everywhere else in this codebase a key is
 *    admin-equivalent (`getOrgContext` hands back `role: null` and the MCP
 *    surface trusts it). That equivalence deliberately stops at the tenant
 *    boundary: a key belongs to one tenant. This is the assertion that keeps
 *    a future "keys are admin-equivalent, just let them through" from being a
 *    silent cross-tenant hole.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canActAsPlatformOperator,
  denyNonOperator,
  resolveActingOrgId,
} from "@/lib/platform-operator";

const { warnCalls, infoCalls } = vi.hoisted(() => ({
  warnCalls: [] as Record<string, unknown>[],
  infoCalls: [] as Record<string, unknown>[],
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: {
    warn: (payload: Record<string, unknown>) => warnCalls.push(payload),
    info: (payload: Record<string, unknown>) => infoCalls.push(payload),
    error: () => undefined,
    debug: () => undefined,
  },
}));

beforeEach(() => {
  warnCalls.length = 0;
  infoCalls.length = 0;
});

describe("canActAsPlatformOperator", () => {
  it("admits SUPER_ADMIN", () => {
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN" })).toBe(true);
  });

  it.each([
    "ADMIN",
    "ORGANIZER",
    "MEMBER",
    "ONSITE",
    "WEBINARS",
    "CRM_USER",
    "REVIEWER",
    "SUBMITTER",
    "REGISTRANT",
  ])("refuses %s", (role) => {
    expect(canActAsPlatformOperator({ role })).toBe(false);
  });

  it("fails closed on an org API key (role null): a key belongs to ONE tenant", () => {
    expect(canActAsPlatformOperator({ role: null })).toBe(false);
  });

  it.each([undefined, "", "FUTURE_ROLE_NOBODY_CLASSIFIED"])(
    "fails closed on %s",
    (role) => {
      expect(canActAsPlatformOperator({ role })).toBe(false);
    },
  );

  it("fails closed on a null/undefined user", () => {
    expect(canActAsPlatformOperator(null)).toBe(false);
    expect(canActAsPlatformOperator(undefined)).toBe(false);
  });
});

/**
 * The org binding. Without it "SUPER_ADMIN" is unqualified, so a SUPER_ADMIN
 * row belonging to a TENANT would be a platform operator and could read every
 * other tenant's data. Nothing but a UI convention (SUPER_ADMIN is absent from
 * ASSIGNABLE_USER_ROLES) stops such a row existing, and the tenant-onboarding
 * flow that would have to inherit that convention is not built yet.
 */
describe("PLATFORM_ORG_ID binding", () => {
  const ORIGINAL = process.env.PLATFORM_ORG_ID;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PLATFORM_ORG_ID;
    else process.env.PLATFORM_ORG_ID = ORIGINAL;
  });

  it("unset (master): any SUPER_ADMIN is the operator, exactly as before", () => {
    delete process.env.PLATFORM_ORG_ID;
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN", organizationId: "mmg" })).toBe(true);
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN", organizationId: null })).toBe(true);
  });

  it("set: only the platform org's SUPER_ADMIN qualifies", () => {
    process.env.PLATFORM_ORG_ID = "platform-org";
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN", organizationId: "platform-org" })).toBe(true);
  });

  it("set: a TENANT's SUPER_ADMIN is refused", () => {
    process.env.PLATFORM_ORG_ID = "platform-org";
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN", organizationId: "acme" })).toBe(false);
    expect(canActAsPlatformOperator({ role: "SUPER_ADMIN", organizationId: null })).toBe(false);
  });
});

describe("denyNonOperator", () => {
  it("returns null for SUPER_ADMIN and logs nothing", () => {
    const res = denyNonOperator({ user: { id: "u1", role: "SUPER_ADMIN" } }, { route: "x" });
    expect(res).toBeNull();
    expect(warnCalls).toHaveLength(0);
  });

  it("403s with OPERATOR_ONLY for an admin of a single tenant", async () => {
    const res = denyNonOperator({ user: { id: "u2", role: "ADMIN" } }, { route: "help-chat:queries" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "Forbidden", code: "OPERATOR_ONLY" });
  });

  it("logs the refusal itself so no call site can forget", () => {
    denyNonOperator({ user: { id: "u2", role: "ORGANIZER" } }, { route: "help-chat:queries" });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatchObject({
      msg: "platform-operator:denied",
      role: "ORGANIZER",
      userId: "u2",
      route: "help-chat:queries",
    });
  });

  it("refuses a null session", () => {
    const res = denyNonOperator(null);
    expect(res!.status).toBe(403);
    expect(warnCalls[0]).toMatchObject({ role: null, userId: null });
  });
});

/**
 * resolveActingOrgId — the x-org-id override (Aug 21 2026 ADMIN-gate sweep).
 *
 * The load-bearing assertion is the REFUSAL, not the happy path. Six call
 * sites honoured this header on `role === "SUPER_ADMIN"` alone; on the platform
 * that is a tenant's own admin, and through PUT /api/organization it was a
 * cross-tenant WRITE.
 *
 * Note the direction of failure this differs from. The five defects the tenancy
 * rehearsal found all failed CLOSED — no lane, RLS matches nothing, empty page.
 * This one failed OPEN: the overridden id is used directly, so a later
 * runWithTenant(orgId) enters the TARGET tenant's lane and RLS serves their
 * rows correctly. RLS cannot defend against being handed the wrong tenant id,
 * which is why this has to be right in the application layer.
 */
describe("resolveActingOrgId", () => {
  const ORIGINAL = process.env.PLATFORM_ORG_ID;
  const req = (orgId?: string) =>
    ({ headers: { get: (h: string) => (h === "x-org-id" ? (orgId ?? null) : null) } }) as unknown as Request;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PLATFORM_ORG_ID;
    else process.env.PLATFORM_ORG_ID = ORIGINAL;
  });

  it("returns the caller's own org when no header is present", () => {
    delete process.env.PLATFORM_ORG_ID;
    const user = { id: "u1", role: "SUPER_ADMIN", organizationId: "own" };
    expect(resolveActingOrgId(req(), user, "own")).toBe("own");
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(0);
  });

  it("is silent when the header names the caller's own org", () => {
    // The dashboard org switcher sets the header routinely, including when it
    // names the current org. Logging that would bury the refusals below.
    delete process.env.PLATFORM_ORG_ID;
    const user = { id: "u1", role: "ADMIN", organizationId: "own" };
    expect(resolveActingOrgId(req("own"), user, "own")).toBe("own");
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls).toHaveLength(0);
  });

  it("REFUSES a tenant ADMIN and returns their own org", () => {
    delete process.env.PLATFORM_ORG_ID;
    const user = { id: "u1", role: "ADMIN", organizationId: "tenant-a" };
    expect(resolveActingOrgId(req("tenant-b"), user, "tenant-a")).toBe("tenant-a");
    expect(warnCalls[0]).toMatchObject({
      msg: "platform-operator:org-override-refused",
      requestedOrgId: "tenant-b",
    });
  });

  it("REFUSES a TENANT's own SUPER_ADMIN once PLATFORM_ORG_ID is set", () => {
    // The whole point. Before this fix the role alone was the gate, so a
    // customer's SUPER_ADMIN could read and write any other tenant's org.
    process.env.PLATFORM_ORG_ID = "platform-org";
    const user = { id: "u1", role: "SUPER_ADMIN", organizationId: "tenant-a" };
    expect(resolveActingOrgId(req("tenant-b"), user, "tenant-a")).toBe("tenant-a");
    expect(warnCalls[0]).toMatchObject({ msg: "platform-operator:org-override-refused" });
  });

  it("HONOURS the override for the platform operator, and logs it", () => {
    process.env.PLATFORM_ORG_ID = "platform-org";
    const user = { id: "op", role: "SUPER_ADMIN", organizationId: "platform-org" };
    expect(resolveActingOrgId(req("tenant-b"), user, "platform-org", { route: "r" })).toBe("tenant-b");
    expect(warnCalls).toHaveLength(0);
    expect(infoCalls[0]).toMatchObject({
      msg: "platform-operator:org-override",
      actingOrgId: "tenant-b",
      route: "r",
    });
  });

  it("MASTER IS UNCHANGED: with PLATFORM_ORG_ID unset, SUPER_ADMIN still switches org", () => {
    // This is the assertion that lets the fix ship to a live single-org system:
    // the dashboard org switcher must keep working exactly as before.
    delete process.env.PLATFORM_ORG_ID;
    const user = { id: "mmg", role: "SUPER_ADMIN", organizationId: "mmg" };
    expect(resolveActingOrgId(req("other-mmg-org"), user, "mmg")).toBe("other-mmg-org");
  });

  it("refuses an API-key caller (role null), like every other operator surface", () => {
    delete process.env.PLATFORM_ORG_ID;
    const user = { role: null, organizationId: "tenant-a" };
    expect(resolveActingOrgId(req("tenant-b"), user, "tenant-a")).toBe("tenant-a");
    expect(warnCalls[0]).toMatchObject({ msg: "platform-operator:org-override-refused" });
  });

  it("refuses a null user", () => {
    delete process.env.PLATFORM_ORG_ID;
    expect(resolveActingOrgId(req("tenant-b"), null, "tenant-a")).toBe("tenant-a");
    expect(warnCalls).toHaveLength(1);
  });
});
