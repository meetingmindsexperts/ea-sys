/**
 * CRM harness fixtures — real rows in the real DB, plus a per-test reset.
 *
 * `db` is the app's own singleton (@/lib/db), pointed at the harness DB by
 * setup-env, so the SAME connection seeds and asserts — no mock, no second
 * client. `resetCrm()` truncates the org graph (CASCADE clears every Crm*
 * table) and seeds one org + one admin, returning their ids.
 */
import { db } from "@/lib/db";

export interface CrmSeed {
  orgId: string;
  userId: string;
}

let counter = 0;

export async function resetCrm(): Promise<CrmSeed> {
  // TRUNCATE … CASCADE from Organization + User clears the whole org-scoped
  // graph (all Crm* tables cascade off Organization). Fast on a small dataset.
  await db.$executeRawUnsafe('TRUNCATE TABLE "Organization", "User" RESTART IDENTITY CASCADE');

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
