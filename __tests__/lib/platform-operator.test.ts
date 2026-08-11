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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { canActAsPlatformOperator, denyNonOperator } from "@/lib/platform-operator";

const { warnCalls } = vi.hoisted(() => ({ warnCalls: [] as Record<string, unknown>[] }));

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
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

beforeEach(() => {
  warnCalls.length = 0;
});

describe("canActAsPlatformOperator", () => {
  it("admits SUPER_ADMIN", () => {
    expect(canActAsPlatformOperator("SUPER_ADMIN")).toBe(true);
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
    expect(canActAsPlatformOperator(role)).toBe(false);
  });

  it("fails closed on an org API key (role null): a key belongs to ONE tenant", () => {
    expect(canActAsPlatformOperator(null)).toBe(false);
  });

  it.each([undefined, "", "FUTURE_ROLE_NOBODY_CLASSIFIED"])(
    "fails closed on %s",
    (role) => {
      expect(canActAsPlatformOperator(role as string | undefined)).toBe(false);
    },
  );
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
