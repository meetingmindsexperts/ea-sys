/**
 * Per-tenant email uniqueness (PLATFORM_DECISIONS item 6), enforced by
 * prisma/platform/010-user-identity.sql — the SAME file the platform bootstrap
 * applies.
 *
 * NOT an RLS test. `User` carries no policy: it is read on the authentication
 * path, which is what ESTABLISHES the tenant lane, so it cannot be protected by
 * one. What this pins is the constraint that replaces the global unique index.
 *
 * WHY IT NEEDS A REAL DATABASE
 * ----------------------------
 * The unit suite asserts the SQL *says* `NULLS NOT DISTINCT`. Only Postgres can
 * say whether that produces the behaviour intended, and the failure mode is the
 * quiet kind: a plain UNIQUE over a nullable column creates an index that
 * exists, looks like protection, and permits unlimited duplicates. Nothing
 * short of trying the insert distinguishes the two.
 *
 * These rows are created and removed by the test itself rather than seeded,
 * because they exist to violate a constraint — a fixture that lived in
 * seed-tenancy.ts would have to succeed at being seeded first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { applyPolicyFiles, platformOnlyDir } from "../../prisma/rls/apply";
import { findUserByEmail } from "@/lib/tenant/user-lookup";
import { ORG_A_ID, ORG_B_ID } from "./constants";

const SHARED = "same.person@tenancy.test";
const ORPHAN = "no.org@tenancy.test";
/** Held by tenant A AND by an org-less row — the preference case. */
const CONTESTED = "contested@tenancy.test";
/** Held ONLY by an org-less row — the master sign-in case. */
const ORGLESS_ONLY = "orgless.only@tenancy.test";
const IDS = [
  "tenancy-ident-a",
  "tenancy-ident-b",
  "tenancy-ident-dupe",
  "tenancy-ident-null-1",
  "tenancy-ident-null-2",
  "tenancy-ident-contested-a",
  "tenancy-ident-contested-null",
  "tenancy-ident-orgless-only",
];

const mk = (id: string, email: string, organizationId: string | null) =>
  db.user.create({
    data: {
      id,
      email,
      organizationId,
      firstName: "T",
      lastName: "T",
      role: "REGISTRANT",
      passwordHash: "not-a-real-hash",
    },
  });

/**
 * WHY THIS FILE APPLIES THE CONSTRAINT ITSELF
 * -------------------------------------------
 * global-setup runs `prisma db push`, which re-syncs the harness DB to
 * schema.prisma on EVERY run. prisma/platform/010-user-identity.sql
 * deliberately diverges from schema.prisma — it drops the `email @unique` index
 * that push keeps putting back — so applying it in the shared setup makes the
 * SECOND run fail: push finds the index missing and refuses to re-add it
 * without --accept-data-loss. (The platform is unaffected: it runs
 * `migrate deploy`, which skips already-applied migrations, so the drop
 * persists.)
 *
 * So the constraint is applied here, over the OWNER connection, and the global
 * index is restored afterwards — leaving the DB exactly as db push expects it.
 * The file applied is the REAL one the bootstrap runs, not a copy: a constraint
 * proven against a hand-written copy is evidence about the copy.
 */
const owner = new PrismaClient({
  datasources: { db: { url: process.env.TENANCY_DIRECT_URL } },
});

beforeAll(async () => {
  await applyPolicyFiles(owner, [platformOnlyDir()]);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: IDS } } });
  // Restore what schema.prisma declares, so the next `db push` sees no drift.
  // If this does not run (a killed process), the next harness run fails on the
  // push with "Use the --accept-data-loss flag"; the fix is the documented
  // schema reset in global-setup.ts.
  await owner.$executeRawUnsafe('DROP INDEX IF EXISTS "User_organizationId_email_key"');
  await owner.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"(email)',
  );
  await owner.$disconnect();
  await db.$disconnect();
});

describe("User identity: unique per tenant, not globally", () => {
  it("lets the SAME email exist in two different tenants", async () => {
    // The whole point of item 6. Under the global unique index this second
    // insert is a P2002, and a doctor attending two tenants' events would be
    // told the address is taken by a system they have never heard of.
    await mk(IDS[0], SHARED, ORG_A_ID);
    await mk(IDS[1], SHARED, ORG_B_ID);

    const rows = await db.user.findMany({
      where: { email: SHARED },
      select: { organizationId: true },
    });
    expect(rows.map((r) => r.organizationId).sort()).toEqual([ORG_A_ID, ORG_B_ID].sort());
  });

  it("still refuses the same email TWICE inside one tenant", async () => {
    // The half that is easy to lose while making the first half work.
    await expect(mk(IDS[2], SHARED, ORG_A_ID)).rejects.toMatchObject({ code: "P2002" });
  });

  it("falls back to GLOBAL uniqueness for an org-less row (NULLS NOT DISTINCT)", async () => {
    // Postgres treats NULLs as distinct by default, so without NULLS NOT
    // DISTINCT this second insert SUCCEEDS and org-null rows get no uniqueness
    // whatsoever. That is the trap in PLATFORM_DECISIONS §6, and this assertion
    // is the only thing in the suite that can tell the two apart.
    await mk(IDS[3], ORPHAN, null);
    await expect(mk(IDS[4], ORPHAN, null)).rejects.toMatchObject({ code: "P2002" });
  });
});

/**
 * The other half of item 6: the CODE that has to survive the dropped index.
 *
 * Prisma still believes `email` is `@unique`, so every
 * `findUnique({ where: { email } })` in the codebase keeps compiling and keeps
 * running once `User_email_key` is gone — it just returns whichever of the
 * candidate rows the planner reaches first. Dropping an index cannot make
 * application code fail loudly, which is why these two assertions have to be
 * made against a real planner rather than a mock: the unit suite can prove the
 * query ASKS for nulls-last, and nothing else.
 */
describe("findUserByEmail resolves the right row once email is per-tenant", () => {
  it("prefers the TENANT's account over an org-less one with the same address", async () => {
    await mk(IDS[5], CONTESTED, ORG_A_ID);
    await mk(IDS[6], CONTESTED, null);

    const row = await findUserByEmail({ organizationId: ORG_A_ID }, CONTESTED, {
      select: { id: true, organizationId: true },
    });
    expect(row).toEqual({ id: IDS[5], organizationId: ORG_A_ID });
  });

  it("still finds an ORG-LESS account under a tenant scope", async () => {
    // Master's ordinary case, and the reason the org-less branch exists at all:
    // 113 of its 126 accounts carry no org. A strict `{ organizationId, email }`
    // lookup returns null here and nobody signs in.
    await mk(IDS[7], ORGLESS_ONLY, null);

    const row = await findUserByEmail({ organizationId: ORG_A_ID }, ORGLESS_ONLY, {
      select: { id: true, organizationId: true },
    });
    expect(row).toEqual({ id: IDS[7], organizationId: null });
  });

  it("does NOT reach into another tenant", async () => {
    // SHARED exists in A and in B. Scoped to B, tenant A's row must be
    // invisible — this is the cross-tenant sign-in the whole exercise prevents.
    const row = await findUserByEmail({ organizationId: ORG_B_ID }, SHARED, {
      select: { id: true, organizationId: true },
    });
    expect(row).toEqual({ id: IDS[1], organizationId: ORG_B_ID });
  });
});
