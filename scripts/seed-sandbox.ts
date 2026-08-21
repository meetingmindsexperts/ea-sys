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
    primaryColor: "#0d7d6c",
    venue: "Acme Convention Centre",
    city: "Dubai",
    country: "United Arab Emirates",
    delegatePrice: 450,
    studentPrice: 150,
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
    primaryColor: "#7c3aed",
    venue: "Globex Exhibition Hall",
    city: "Singapore",
    country: "Singapore",
    delegatePrice: 600,
    studentPrice: 200,
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
    // logo is pinned to null on BOTH branches, deliberately. public/uploads/ is
    // a single flat directory shared with the local production copy (see
    // npm run uploads:refresh), so anything picked from the media library here
    // is a REAL uploaded file — a live client's logo can end up rendering as a
    // fictional tenant's branding, which is exactly what happened once. The
    // text fallback is unmistakably generic and cannot borrow anybody's mark.
    // primaryColor differs per tenant so the two are distinguishable at a
    // glance, and because per-tenant theming is itself worth demonstrating.
    await db.organization.upsert({
      where: { id: t.orgId },
      update: { name: t.name, slug: t.slug, logo: null, primaryColor: t.primaryColor },
      create: {
        id: t.orgId,
        name: t.name,
        slug: t.slug,
        logo: null,
        primaryColor: t.primaryColor,
        settings: {},
      },
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
      update: {
        name: t.eventName,
        status: "PUBLISHED",
        organizationId: t.orgId,
        venue: t.venue,
        city: t.city,
        country: t.country,
      },
      create: {
        id: t.eventId,
        organizationId: t.orgId,
        name: t.eventName,
        slug: SHARED_SLUG,
        venue: t.venue,
        city: t.city,
        country: t.country,
        startDate: start,
        endDate: end,
        timezone: "Asia/Dubai",
        eventType: "CONFERENCE",
        status: "PUBLISHED",
      },
    });

    // Registration types with an OPEN pricing tier.
    //
    // Without these the public page renders "Registration Closed", which is
    // technically fine for proving isolation (the event NAME already differs)
    // but reads as a broken product to anyone being shown it. The smart
    // redirect on /e/<slug> looks for the first purchasable DELEGATE tier and
    // sends the visitor to its form; "Early Bird" is one of the names it ranks.
    //
    // salesStart and salesEnd are both left NULL deliberately: null start means
    // already on sale, null end means never closes, so the sandbox cannot go
    // stale the way a hard-coded window would the moment the seeded event date
    // passes. Prices differ per tenant so the two public pages differ in more
    // than their heading.
    for (const [i, tier] of [
      { key: "delegate", label: "Delegate", price: t.delegatePrice },
      { key: "student", label: "Student", price: t.studentPrice },
    ].entries()) {
      const ticketTypeId = `sandbox-tt-${t.slug}-${tier.key}`;
      await db.ticketType.upsert({
        where: { id: ticketTypeId },
        update: { name: tier.label, organizationId: t.orgId, isActive: true },
        create: {
          id: ticketTypeId,
          eventId: t.eventId,
          organizationId: t.orgId,
          name: tier.label,
          description: `${tier.label} admission, all three days.`,
          price: 0, // real price lives on the tier below
          currency: "USD",
          sortOrder: i,
        },
      });

      const tierId = `sandbox-tier-${t.slug}-${tier.key}`;
      await db.pricingTier.upsert({
        where: { id: tierId },
        update: { price: tier.price, organizationId: t.orgId, isActive: true },
        create: {
          id: tierId,
          ticketTypeId,
          organizationId: t.orgId,
          name: "Early Bird",
          price: tier.price,
          currency: "USD",
          sortOrder: i,
        },
      });
    }

    // ONE row per swept domain, so every domain has something to find.
    //
    // The point is not realism, it is that an isolation check can distinguish
    // "this tenant's row" from "the other tenant's row" from "nothing at all".
    // Every value below is prefixed with the tenant slug for exactly that: a
    // probe asserts its own marker is present AND the other's is absent, and
    // one row per side is enough to tell all three states apart. Without a row
    // to find, a broken lane and a correct one look identical — which is how
    // four bugs survived until now.
    //
    // organizationId is stamped explicitly everywhere it exists. These are
    // policied tables, so a row seeded without it is invisible to its own
    // tenant and the fixture silently proves nothing.
    await db.track.upsert({
      where: { id: `sandbox-track-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-track-${t.slug}`,
        eventId: t.eventId,
        organizationId: t.orgId,
        name: `${t.name} Main Track`,
      },
    });

    await db.eventSession.upsert({
      where: { id: `sandbox-session-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-session-${t.slug}`,
        eventId: t.eventId,
        organizationId: t.orgId,
        trackId: `sandbox-track-${t.slug}`,
        name: `${t.name} Opening Keynote`,
        location: t.venue,
        startTime: new Date("2026-11-01T09:00:00Z"),
        endTime: new Date("2026-11-01T10:00:00Z"),
      },
    });

    await db.attendee.upsert({
      where: { id: `sandbox-attendee-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-attendee-${t.slug}`,
        organizationId: t.orgId,
        firstName: t.name.split(" ")[0],
        lastName: "Delegate",
        email: `delegate@${t.slug}.test`,
      },
    });

    await db.registration.upsert({
      where: { id: `sandbox-reg-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-reg-${t.slug}`,
        eventId: t.eventId,
        organizationId: t.orgId,
        attendeeId: `sandbox-attendee-${t.slug}`,
        ticketTypeId: `sandbox-tt-${t.slug}-delegate`,
        pricingTierId: `sandbox-tier-${t.slug}-delegate`,
        status: "CONFIRMED",
        paymentStatus: "PAID",
        serialId: 1,
        // Globally unique, so it doubles as proof the two tenants are not
        // sharing a row when both lists show "one registration".
        qrCode: `SANDBOX-${t.slug.toUpperCase()}-0001`,
      },
    });

    await db.abstract.upsert({
      where: { id: `sandbox-abstract-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-abstract-${t.slug}`,
        eventId: t.eventId,
        organizationId: t.orgId,
        speakerId: t.speakerId,
        title: `${t.name} Abstract Submission`,
        content: `Submitted to ${t.eventName}.`,
        status: "SUBMITTED",
      },
    });

    // CRM: its own contact population, deliberately separate from the event
    // Contact store (they are different people in this product).
    // Reuse whatever pipeline the org already has, and only create one if it
    // has none.
    //
    // The app seeds a default pipeline (ensurePipelineStages) the first time
    // anybody opens the CRM, so this table has TWO writers and the seed is not
    // the authoritative one. An earlier version keyed this upsert on a
    // synthetic id and therefore tried to CREATE a stage named "New" next to
    // the app's existing "New", which violates @@unique([organizationId, name])
    // and threw — taking the rest of the seed, and the whole second tenant,
    // with it. Key a fixture on the table's REAL identity, never on an id you
    // invented, whenever anything else can write the same row.
    const stage =
      (await db.crmPipelineStage.findFirst({
        where: { organizationId: t.orgId },
        orderBy: { sortOrder: "asc" },
      })) ??
      (await db.crmPipelineStage.create({
        data: { organizationId: t.orgId, name: "New", sortOrder: 0 },
      }));

    const company = await db.crmCompany.upsert({
      where: { organizationId_nameKey: { organizationId: t.orgId, nameKey: `${t.slug} sponsor co` } },
      update: {},
      create: {
        organizationId: t.orgId,
        name: `${t.name} Sponsor Co`,
        nameKey: `${t.slug} sponsor co`,
      },
    });

    await db.crmContact.upsert({
      where: { organizationId_emailKey: { organizationId: t.orgId, emailKey: `sponsor@${t.slug}.test` } },
      update: {},
      create: {
        organizationId: t.orgId,
        companyId: company.id,
        firstName: t.name.split(" ")[0],
        lastName: "Sponsor",
        email: `sponsor@${t.slug}.test`,
        emailKey: `sponsor@${t.slug}.test`,
      },
    });

    await db.crmDeal.upsert({
      where: { id: `sandbox-deal-${t.slug}` },
      update: { organizationId: t.orgId },
      create: {
        id: `sandbox-deal-${t.slug}`,
        organizationId: t.orgId,
        eventId: t.eventId,
        companyId: company.id,
        stageId: stage.id,
        name: `${t.name} Platinum Sponsorship`,
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
