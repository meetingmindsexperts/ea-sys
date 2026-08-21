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

vi.mock("@/lib/db", () => ({ db: { user: { findFirst: vi.fn() } } }));

import { db } from "@/lib/db";
import {
  findUserByEmail,
  userEmailScope,
  userEmailWhere,
  USER_EMAIL_ORDER_BY,
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
