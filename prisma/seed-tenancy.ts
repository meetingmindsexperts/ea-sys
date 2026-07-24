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
  SHARED_CONTACT_EMAIL,
  CONTACT_A_SHARED_ID,
  CONTACT_B_SHARED_ID,
  ORG_B_ONLY_CONTACT_EMAIL,
  CONTACT_B_ONLY_ID,
  UPLOADER_A_ID,
  UPLOADER_B_ID,
  SHARED_MEDIA_URL,
  MEDIA_A_SHARED_ID,
  MEDIA_B_SHARED_ID,
  ORG_B_ONLY_MEDIA_URL,
  MEDIA_B_ONLY_ID,
  SHARED_PAYER_NAME,
  BILLING_A_SHARED_ID,
  BILLING_B_SHARED_ID,
  ORG_B_ONLY_PAYER_NAME,
  BILLING_B_ONLY_ID,
} from "../tests/tenancy/constants";

const url = process.env.TENANCY_DIRECT_URL;
if (!url) throw new Error("TENANCY_DIRECT_URL must be set for the tenancy seed");

const db = new PrismaClient({ datasourceUrl: url });

async function seedOrg(
  orgId: string,
  host: string,
  events: { id: string; slug: string }[],
  contacts: { id: string; email: string }[] = [],
  uploader?: { id: string; media: { id: string; url: string }[] },
  billing: { id: string; name: string }[] = [],
) {
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
  // Contacts pilot fixtures (org cascade wipes these on re-run too).
  for (const ct of contacts) {
    await db.contact.create({
      data: {
        id: ct.id,
        organizationId: orgId,
        email: ct.email,
        firstName: "Tenancy",
        lastName: `Contact ${ct.id}`,
      },
    });
  }
  // MediaFile fast-follow fixtures. uploadedById is a required FK, so mint an
  // uploader User per org first (cascade-wiped with the org; also cleaned
  // explicitly in main() because MediaFile→User is a cross-child FK).
  if (uploader) {
    await db.user.create({
      data: {
        id: uploader.id,
        organizationId: orgId,
        email: `${uploader.id}@tenancy.test`,
        passwordHash: "x", // no login happens in the harness
        firstName: "Tenancy",
        lastName: "Uploader",
      },
    });
    for (const m of uploader.media) {
      await db.mediaFile.create({
        data: {
          id: m.id,
          organizationId: orgId,
          uploadedById: uploader.id,
          filename: `${m.id}.png`,
          url: m.url,
          mimeType: "image/png",
          size: 1024,
        },
      });
    }
  }
  // BillingAccount sweep fixtures (org cascade wipes these — no FK to User).
  for (const ba of billing) {
    await db.billingAccount.create({
      data: { id: ba.id, organizationId: orgId, name: ba.name },
    });
  }
}

async function main() {
  // MediaFile → User is a cross-child FK (not org-cascade-ordered), so wipe the
  // media + uploader users explicitly before the org cascade handles the rest.
  await db.mediaFile.deleteMany({
    where: { id: { in: [MEDIA_A_SHARED_ID, MEDIA_B_SHARED_ID, MEDIA_B_ONLY_ID] } },
  });
  await db.user.deleteMany({ where: { id: { in: [UPLOADER_A_ID, UPLOADER_B_ID] } } });
  // Cascade wipes events + contacts + tenant domains of prior runs.
  await db.organization.deleteMany({ where: { id: { in: [ORG_A_ID, ORG_B_ID] } } });

  await seedOrg(
    ORG_A_ID,
    HOST_A,
    [{ id: EVENT_A_SHARED_ID, slug: SHARED_SLUG }],
    [{ id: CONTACT_A_SHARED_ID, email: SHARED_CONTACT_EMAIL }],
    { id: UPLOADER_A_ID, media: [{ id: MEDIA_A_SHARED_ID, url: SHARED_MEDIA_URL }] },
    [{ id: BILLING_A_SHARED_ID, name: SHARED_PAYER_NAME }],
  );
  await seedOrg(
    ORG_B_ID,
    HOST_B,
    [
      { id: EVENT_B_SHARED_ID, slug: SHARED_SLUG },
      { id: EVENT_B_ONLY_ID, slug: ORG_B_ONLY_SLUG },
    ],
    [
      { id: CONTACT_B_SHARED_ID, email: SHARED_CONTACT_EMAIL },
      { id: CONTACT_B_ONLY_ID, email: ORG_B_ONLY_CONTACT_EMAIL },
    ],
    {
      id: UPLOADER_B_ID,
      media: [
        { id: MEDIA_B_SHARED_ID, url: SHARED_MEDIA_URL },
        { id: MEDIA_B_ONLY_ID, url: ORG_B_ONLY_MEDIA_URL },
      ],
    },
    [
      { id: BILLING_B_SHARED_ID, name: SHARED_PAYER_NAME },
      { id: BILLING_B_ONLY_ID, name: ORG_B_ONLY_PAYER_NAME },
    ],
  );

  console.log(
    "[tenancy:seed] two tenants seeded (shared slug + contact email + media url + payer name on both)",
  );
}

main()
  .catch((err) => {
    console.error("[tenancy:seed] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
