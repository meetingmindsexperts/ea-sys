/**
 * Seed the LOCAL multi-tenant RLS sandbox — see docs/SANDBOX.md.
 *
 * Two throwaway tenants (Acme / Globex) in the dedicated `sandbox` database,
 * each with: an Organization, a VERIFIED TenantDomain (acme.localhost /
 * globex.localhost — the host the resolver routes on), an ADMIN user, a
 * PUBLISHED event sharing the SAME slug (to demo host-based public routing),
 * and one Contact + one Speaker (swept tables — you should see these isolated
 * once RLS is on).
 *
 * Connects as the OWNER (bypasses RLS, has CREATE privileges) so it can write
 * cross-org fixtures in one pass; the running app reads as the non-owner
 * `app_user`, where RLS actually enforces. Idempotent (upserts) — re-run any
 * time (e.g. after `npm run test:tenancy`, which touches a DIFFERENT db).
 *
 * LOCAL SANDBOX ONLY — never pointed at any prod database.
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const OWNER_URL =
  process.env.SANDBOX_OWNER_URL || "postgresql://postgres:postgres@localhost:55432/sandbox";

const db = new PrismaClient({ datasourceUrl: OWNER_URL });

const PASSWORD = "sandbox123";
const SHARED_SLUG = "annual-summit";

const TENANTS = [
  {
    orgId: "sandbox-org-acme",
    name: "Acme Events",
    slug: "acme",
    host: "acme.localhost",
    adminEmail: "admin@acme.test",
    eventId: "sandbox-evt-acme",
    eventName: "Acme Annual Summit 2026",
    contactId: "sandbox-contact-acme",
    speakerId: "sandbox-speaker-acme",
  },
  {
    orgId: "sandbox-org-globex",
    name: "Globex Summits",
    slug: "globex",
    host: "globex.localhost",
    adminEmail: "admin@globex.test",
    eventId: "sandbox-evt-globex",
    eventName: "Globex Annual Summit 2026",
    contactId: "sandbox-contact-globex",
    speakerId: "sandbox-speaker-globex",
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const start = new Date("2026-11-01T09:00:00Z");
  const end = new Date("2026-11-03T18:00:00Z");

  for (const t of TENANTS) {
    await db.organization.upsert({
      where: { id: t.orgId },
      update: { name: t.name, slug: t.slug },
      create: { id: t.orgId, name: t.name, slug: t.slug, settings: {} },
    });

    await db.tenantDomain.upsert({
      where: { domain: t.host },
      update: { organizationId: t.orgId, isPrimary: true, verifiedAt: new Date() },
      create: { domain: t.host, organizationId: t.orgId, isPrimary: true, verifiedAt: new Date() },
    });

    await db.user.upsert({
      where: { email: t.adminEmail },
      update: { organizationId: t.orgId, role: "ADMIN", passwordHash, emailVerified: new Date() },
      create: {
        email: t.adminEmail,
        firstName: t.name.split(" ")[0],
        lastName: "Admin",
        passwordHash,
        role: "ADMIN",
        organizationId: t.orgId,
        emailVerified: new Date(),
      },
    });

    // Same slug in BOTH orgs — allowed by @@unique([organizationId, slug]) and
    // the whole point of the public host-routing demo.
    await db.event.upsert({
      where: { id: t.eventId },
      update: { name: t.eventName, status: "PUBLISHED", organizationId: t.orgId },
      create: {
        id: t.eventId,
        organizationId: t.orgId,
        name: t.eventName,
        slug: SHARED_SLUG,
        startDate: start,
        endDate: end,
        timezone: "Asia/Dubai",
        eventType: "CONFERENCE",
        status: "PUBLISHED",
      },
    });

    // A swept-table row per org so isolation is visible immediately (no need
    // to create one by hand): /contacts and the event's Speakers page.
    await db.contact.upsert({
      where: { id: t.contactId },
      update: { organizationId: t.orgId },
      create: {
        id: t.contactId,
        organizationId: t.orgId,
        firstName: t.name.split(" ")[0],
        lastName: "Contact",
        email: `contact@${t.slug}.test`,
      },
    });

    await db.speaker.upsert({
      where: { id: t.speakerId },
      update: { organizationId: t.orgId, eventId: t.eventId },
      create: {
        id: t.speakerId,
        eventId: t.eventId,
        organizationId: t.orgId,
        firstName: t.name.split(" ")[0],
        lastName: "Speaker",
        email: `speaker@${t.slug}.test`,
      },
    });
  }

  // A platform-operator SUPER_ADMIN for GLOBAL observability (logs, sign-in
  // activity, worker health, system errors) — those surfaces are NOT tenant
  // data, so they work regardless of org. Org-bound to Acme so org-scoped
  // pages still resolve cleanly; TRUE cross-tenant data debugging (seeing INTO
  // any tenant) needs the "act as tenant" switcher — see docs/SANDBOX.md.
  await db.user.upsert({
    where: { email: "super@sandbox.test" },
    update: { role: "SUPER_ADMIN", passwordHash, emailVerified: new Date(), organizationId: "sandbox-org-acme" },
    create: {
      email: "super@sandbox.test",
      firstName: "Sandbox",
      lastName: "SuperAdmin",
      passwordHash,
      role: "SUPER_ADMIN",
      organizationId: "sandbox-org-acme",
      emailVerified: new Date(),
    },
  });

  console.log("✅ sandbox seeded:");
  for (const t of TENANTS) {
    console.log(`   ${t.host}  →  ${t.name}  (login: ${t.adminEmail} / ${PASSWORD})`);
  }
  console.log(`   SUPER_ADMIN (logs/activity/health): super@sandbox.test / ${PASSWORD}  (home org: Acme)`);
  console.log(`   Shared public slug: /e/${SHARED_SLUG}  (serves each org's own event by host)`);
}

main()
  .catch((e) => {
    console.error("sandbox seed failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
