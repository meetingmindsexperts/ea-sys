/**
 * Two-tenant seed for the tenant-isolation harness (tests/tenancy).
 *
 * Deliberately NOT built on seed-e2e-core (which mints 5 bcrypt users, ticket
 * types, registrations — none needed here). Runs as the OWNER role via
 * TENANCY_DIRECT_URL (RLS would block the non-owner app role from seeding
 * cross-tenant rows — that's the point of the harness). Idempotent: deletes
 * the fixed-id orgs first (FK cascades take the events/domains with them).
 */
import { PrismaClient } from "@prisma/client";
import {
  ORG_A_ID,
  ORG_B_ID,
  HOST_A,
  HOST_B,
  SHARED_SLUG,
  EVENT_A_SHARED_ID,
  EVENT_B_SHARED_ID,
  ORG_B_ONLY_SLUG,
  EVENT_B_ONLY_ID,
} from "../tests/tenancy/constants";

const url = process.env.TENANCY_DIRECT_URL;
if (!url) throw new Error("TENANCY_DIRECT_URL must be set for the tenancy seed");

const db = new PrismaClient({ datasourceUrl: url });

async function seedOrg(orgId: string, host: string, events: { id: string; slug: string }[]) {
  await db.organization.create({
    data: {
      id: orgId,
      name: `Tenancy ${orgId}`,
      slug: orgId,
      settings: {},
    },
  });
  await db.tenantDomain.create({
    data: {
      organizationId: orgId,
      domain: host,
      isPrimary: true,
      verifiedAt: new Date(),
    },
  });
  for (const ev of events) {
    await db.event.create({
      data: {
        id: ev.id,
        organizationId: orgId,
        name: `Event ${ev.id}`,
        slug: ev.slug,
        status: "PUBLISHED",
        startDate: new Date("2027-01-10T09:00:00Z"),
        endDate: new Date("2027-01-12T18:00:00Z"),
      },
    });
  }
}

async function main() {
  // Cascade wipes events + tenant domains of prior runs.
  await db.organization.deleteMany({ where: { id: { in: [ORG_A_ID, ORG_B_ID] } } });

  await seedOrg(ORG_A_ID, HOST_A, [{ id: EVENT_A_SHARED_ID, slug: SHARED_SLUG }]);
  await seedOrg(ORG_B_ID, HOST_B, [
    { id: EVENT_B_SHARED_ID, slug: SHARED_SLUG },
    { id: EVENT_B_ONLY_ID, slug: ORG_B_ONLY_SLUG },
  ]);

  console.log("[tenancy:seed] two tenants seeded (shared slug on both)");
}

main()
  .catch((err) => {
    console.error("[tenancy:seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
