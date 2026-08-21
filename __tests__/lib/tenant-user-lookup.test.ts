/**
 * The tenant-aware user-by-email lookup (PLATFORM_DECISIONS item 6, code half).
 *
 * The behaviour that actually matters is proven against Postgres in
 * tests/tenancy/user-identity.test.ts — only a real database can say which row
 * a two-candidate query returns. What this file pins is the CONTRACT the code
 * makes, and in particular the two properties whose loss is silent:
 *
 *   1. a tenant-scoped lookup still finds an ORG-LESS account (without which
 *      90% of master's accounts could not sign in), and
 *   2. the ordering prefers the tenant's own row (without which the org-less
 *      fallback silently outranks the real account).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenant/resolver", () => ({
  normalizeHost: (h: string | null | undefined) => (h ? h.toLowerCase() : null),
  resolveTenantOrg: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { user: { findFirst: vi.fn() } } }));

import { db } from "@/lib/db";
import { resolveTenantOrg } from "@/lib/tenant/resolver";
import {
  findUserByEmail,
  userEmailScope,
  userEmailWhere,
  USER_EMAIL_ORDER_BY,
  scopeFromRequestHost,
} from "@/lib/tenant/user-lookup";

const findFirst = db.user.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  findFirst.mockReset();
});

describe("userEmailScope", () => {
  it("makes a tenant scope from a resolved org id", () => {
    expect(userEmailScope("org-acme", "unused")).toEqual({ organizationId: "org-acme" });
  });

  it("falls back to an UNSCOPED lookup carrying the reason, not to org-less-only", () => {
    // The distinction this test exists for: "no tenant known" and "the account
    // has no tenant" are different questions. Answering the first with a strict
    // org-less lookup would stop every team account signing in whenever the
    // host failed to resolve.
    for (const none of [null, undefined, ""]) {
      expect(userEmailScope(none, "host unresolved")).toEqual({
        unscoped: true,
        reason: "host unresolved",
      });
    }
  });
});

describe("userEmailWhere", () => {
  it("matches this tenant's row OR a tenant-less one", () => {
    expect(userEmailWhere({ organizationId: "org-acme" }, "a@x.test")).toEqual({
      email: "a@x.test",
      OR: [{ organizationId: "org-acme" }, { organizationId: null }],
    });
  });

  it("keeps the org-less branch — a strict org filter would lock out 90% of master", () => {
    // Master: 113 of 126 accounts are org-null BY DESIGN (the Aug 6 ruling:
    // external logins never inherit an event's org). A `{ organizationId,
    // email }` where — the obvious implementation — silently excludes every one
    // of them. Deleting the second OR branch must fail this test.
    const where = userEmailWhere({ organizationId: "org-acme" }, "a@x.test");
    expect(where.OR).toContainEqual({ organizationId: null });
  });

  it("degrades to a bare email match when the caller declares itself unscoped", () => {
    expect(userEmailWhere({ unscoped: true, reason: "why" }, "a@x.test")).toEqual({
      email: "a@x.test",
    });
  });
});

describe("USER_EMAIL_ORDER_BY", () => {
  it("puts NULLS LAST so the tenant's own account outranks a tenant-less one", () => {
    // At most two rows can match, and which one comes back must be a property
    // of the query rather than of the planner. Flipping this to "first" — or
    // dropping the orderBy — makes an org-less account shadow a real tenant
    // account with the same address.
    expect(USER_EMAIL_ORDER_BY).toEqual({
      organizationId: { sort: "asc", nulls: "last" },
    });
  });
});

describe("findUserByEmail", () => {
  it("issues ONE findFirst carrying the where, the select and the ordering", async () => {
    findFirst.mockResolvedValueOnce({ id: "u1" });
    const row = await findUserByEmail({ organizationId: "org-acme" }, "a@x.test", {
      select: { id: true },
    });

    expect(row).toEqual({ id: "u1" });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        email: "a@x.test",
        OR: [{ organizationId: "org-acme" }, { organizationId: null }],
      },
      select: { id: true },
      orderBy: USER_EMAIL_ORDER_BY,
    });
  });

  it("finds an ORG-LESS account under a tenant scope (the master sign-in case)", async () => {
    findFirst.mockImplementationOnce(
      async (args: { where: { OR?: Array<{ organizationId: string | null }> } }) => {
        const matchesOrgless = args.where.OR?.some((c) => c.organizationId === null);
        return matchesOrgless ? { id: "registrant", organizationId: null } : null;
      },
    );
    const row = await findUserByEmail({ organizationId: "org-mmg" }, "doctor@x.test", {
      select: { id: true, organizationId: true },
    });
    expect(row).toEqual({ id: "registrant", organizationId: null });
  });

  it("honours a caller-supplied transaction client", async () => {
    const tx = { user: { findFirst: vi.fn().mockResolvedValue({ id: "in-tx" }) } };
    const row = await findUserByEmail({ unscoped: true, reason: "test" }, "a@x.test", {
      select: { id: true },
      client: tx as never,
    });
    expect(row).toEqual({ id: "in-tx" });
    expect(tx.user.findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("scopeFromRequestHost", () => {
  const resolve = resolveTenantOrg as unknown as ReturnType<typeof vi.fn>;
  const req = (host: string) => new Request("http://x/", { headers: { host } });

  it("uses the org a known host resolves to", async () => {
    resolve.mockResolvedValueOnce({ orgId: "org-acme", source: "domain" });
    expect(await scopeFromRequestHost(req("acme.test"), "r")).toEqual({
      organizationId: "org-acme",
    });
  });

  it("FAILS CLOSED on an unrecognised host when the deployment enforces hosts", async () => {
    // The defect this test exists for, found by driving the sandbox with a
    // forged Host rather than by any assertion: `unknown-enforced` means the
    // request resolves to NOTHING, and treating it as "unscoped" turned
    // sign-in into a universal endpoint reachable with `Host: evil.example`.
    // Returning `{ unscoped: true }` here must fail this test.
    resolve.mockResolvedValueOnce({ orgId: null, source: "unknown-enforced" });
    expect(await scopeFromRequestHost(req("evil.example"), "r")).toEqual({
      none: true,
      reason: "r",
    });
  });

  it("stays UNSCOPED on master, where an unresolved host is the legacy case", async () => {
    // The opposite branch, and it must not be swept up by the fix above:
    // master with no DEFAULT_ORG_ID resolves nothing on purpose, and 90% of its
    // accounts carry no org. Failing closed here locks everyone out.
    resolve.mockResolvedValueOnce({ orgId: null, source: "unscoped" });
    expect(await scopeFromRequestHost(req("anything"), "r")).toEqual({
      unscoped: true,
      reason: "r",
    });
  });
});

describe("a `none` scope matches nothing", () => {
  it("returns null WITHOUT querying the database", async () => {
    const row = await findUserByEmail({ none: true, reason: "r" }, "a@x.test", {
      select: { id: true },
    });
    expect(row).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("builds a match-nothing where, so a composing call site is safe too", () => {
    expect(userEmailWhere({ none: true, reason: "r" }, "a@x.test")).toEqual({
      id: { in: [] },
    });
  });
});
