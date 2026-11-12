/**
 * Integration harness fixtures — real rows in the real DB, plus a per-test reset.
 *
 * `db` is the app's own singleton (@/lib/db), pointed at the harness DB by
 * setup-env, so the SAME connection seeds and asserts — no mock, no second
 * client. `resetCrm()` truncates Organization + User CASCADE, which
 * clears EVERY org-scoped table, not just Crm*, and seeds one org + one admin.
 * Five of the six suites here call it, CRM and non-CRM alike; the name of the
 * function is historical.
 */
import { db } from "@/lib/db";

export interface CrmSeed {
  orgId: string;
  userId: string;
}

let counter = 0;

/** Postgres 40P01, as Prisma hands it back from a raw statement (P2010 with the driver's code in `meta`). */
function isDeadlock(err: unknown): boolean {
  const e = err as { meta?: { code?: unknown }; message?: unknown } | null;
  return e?.meta?.code === "40P01" || /deadlock detected/i.test(String(e?.message ?? ""));
}

/** How many times a reset's TRUNCATE lost a deadlock and was run again (read by reset-deadlock.db.test.ts). */
export const resetStats = { deadlockRetries: 0 };

const TRUNCATE_ATTEMPTS = 6;

/**
 * TRUNCATE Organization + User CASCADE, run again when it loses a deadlock.
 *
 * The services write some rows AFTER they return (History lines, audit rows,
 * notifications: fire-and-forget by design). A test that ends while one is in
 * flight leaves a statement holding a lock on a child table and about to ask
 * for one on Organization (its foreign-key check), while this TRUNCATE holds
 * Organization and waits for the child: a deadlock, and Postgres aborts one of
 * the two. When it aborted the TRUNCATE the NEXT test failed in its
 * `beforeEach`, on a run that had nothing to do with it (a deploy was blocked
 * by it on Nov 12, 2026, in crm-contact-score).
 *
 * Fixed here once, for every suite, rather than by each test waiting for its
 * own stragglers (two files do, and the third had not): the write finishes as
 * soon as the TRUNCATE is aborted, so the second attempt finds nothing in the
 * way. Only 40P01 is retried; every other error is thrown as it was.
 */
async function truncateEverything(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.$executeRawUnsafe('TRUNCATE TABLE "Organization", "User" RESTART IDENTITY CASCADE');
      return;
    } catch (err) {
      if (attempt >= TRUNCATE_ATTEMPTS || !isDeadlock(err)) throw err;
      resetStats.deadlockRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export async function resetCrm(): Promise<CrmSeed> {
  // TRUNCATE … CASCADE from Organization + User clears the whole org-scoped
  // graph (all Crm* tables cascade off Organization). Fast on a small dataset.
  await truncateEverything();

  counter += 1;
  const org = await db.organization.create({
    data: { name: `Test Org ${counter}`, slug: `test-org-${counter}`, companyName: "Test Co" },
    select: { id: true },
  });
  const user = await db.user.create({
    data: {
      organizationId: org.id,
      email: `admin${counter}@test.local`,
      passwordHash: "x",
      firstName: "Ada",
      lastName: "Admin",
      role: "ADMIN",
    },
    select: { id: true },
  });
  return { orgId: org.id, userId: user.id };
}

/** A company + deal + a business contact, all in the seeded org. */
export async function seedDeal(seed: CrmSeed): Promise<{ dealId: string; companyId: string; contactId: string }> {
  const company = await db.crmCompany.create({
    data: { organizationId: seed.orgId, name: "Abbott", nameKey: "abbott" },
    select: { id: true },
  });
  const stage = await db.crmPipelineStage.create({
    data: { organizationId: seed.orgId, name: "New", sortOrder: 0 },
    select: { id: true },
  });
  const deal = await db.crmDeal.create({
    data: {
      organizationId: seed.orgId,
      name: "Abbott — Gold",
      stageId: stage.id,
      companyId: company.id,
      ownerId: seed.userId,
      currency: "USD",
    },
    select: { id: true },
  });
  const contact = await db.crmContact.create({
    data: {
      organizationId: seed.orgId,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@abbott.com",
      emailKey: "jane@abbott.com",
      companyId: company.id,
    },
    select: { id: true },
  });
  return { dealId: deal.id, companyId: company.id, contactId: contact.id };
}
