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
// The REAL catalogue the HR module seeds a live org with. Imported rather
// than retyped so the sandbox cannot drift from what an actual tenant gets.
import { HR_LEAVE_CODE_SEED } from "../src/hr/lib/hr-seed-data";

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

/**
 * The synthetic operator org (PLATFORM_DECISIONS §3). Must match the
 * PLATFORM_ORG_ID that `npm run dev:sandbox` exports — if the two drift, the
 * operator silently stops being one and every cross-tenant surface 403s.
 */
const PLATFORM_ORG_ID = "sandbox-org-platform";
/** The operator console host. Sign-in is host-bound, so the operator needs one. */
const PLATFORM_HOST = "platform.localhost";

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
      // hrAccess is the per-person grant (User.hrAccess, Aug 31 2026). Seeding
      // it here gives the sandbox BOTH arms of canViewHr: this ADMIN passes on
      // the flag, and super@sandbox.test passes on the role. Without one of
      // them nobody could open the HR screens at all and the fixtures below
      // would be unreachable.
      update: { organizationId: t.orgId, role: "ADMIN", passwordHash, emailVerified: new Date(), hrAccess: true },
      create: {
        email: t.adminEmail,
        firstName: t.name.split(" ")[0],
        lastName: "Admin",
        passwordHash,
        role: "ADMIN",
        organizationId: t.orgId,
        emailVerified: new Date(),
        hrAccess: true,
      },
    });

    // A REGISTRANT per tenant, deliberately left UNLINKED to its registration
    // (`userId` stays null below) so signing in exercises the portal's
    // link-on-read sweep as well as the read itself.
    //
    // Added Aug 21 2026 with the registrant tenant lane, and the reason is the
    // same one that produced the operator account the day before: the sandbox
    // had ZERO registrant accounts, so the entire portal — my-registration,
    // invoices, quotes, barcodes, promo codes — had never once run against a
    // deployment with RLS on. `Registration` carries a policy, so without a
    // lane every one of those routes returns nothing, and nothing here could
    // have told us.
    await db.user.upsert({
      where: { email: `delegate@${t.slug}.test` },
      update: { organizationId: t.orgId, role: "REGISTRANT", passwordHash, emailVerified: new Date() },
      create: {
        email: `delegate@${t.slug}.test`,
        firstName: "Dana",
        lastName: "Delegate",
        passwordHash,
        role: "REGISTRANT",
        // Tenant-bound, which is the platform identity model (item 6). On
        // master an external registrant would be org-null; the sandbox models
        // the platform.
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

    // ------------------------------------------------------------------
    // HR fixtures.
    //
    // Added Sep 2 2026 for the same reason the registrant block above exists,
    // and it is worth stating plainly because it has now happened three times:
    // the HR module shipped on Aug 27, six days AFTER the sandbox rehearsal
    // that found the operator lockout and the portal's missing lane. So every
    // HR query has only ever run against a database with no policies on it.
    //
    // Under RLS a missing lane is not an error. It is an empty grid, a summary
    // of nobody, and a green build. Only opening the screens finds it.
    //
    // The values COLLIDE across tenants on purpose: the same empCode, the same
    // holiday date, because that is what makes isolation visible rather than
    // merely asserted: each host must show its OWN row for the same key.
    // ------------------------------------------------------------------
    const leaveCodes = new Map<string, string>();
    for (const [i, c] of HR_LEAVE_CODE_SEED.entries()) {
      const row = await db.leaveCode.upsert({
        where: { organizationId_code: { organizationId: t.orgId, code: c.code } },
        update: { label: c.label, dayWeight: c.dayWeight, countsAs: c.countsAs, paid: c.paid },
        create: {
          organizationId: t.orgId,
          code: c.code,
          label: c.label,
          lawReference: c.lawReference,
          paid: c.paid,
          dayWeight: c.dayWeight,
          countsAs: c.countsAs,
          sortOrder: i,
        },
      });
      leaveCodes.set(c.code, row.id);
    }

    // Same empCode in both orgs. A lane that leaks resolves the wrong person.
    const employees = [
      { code: "E-001", name: `${t.name.split(" ")[0]} Bakhit`, dept: "Operations", joined: "2023-04-01" },
      { code: `E-${t.slug.slice(0, 3).toUpperCase()}`, name: "Jinan Remote", dept: "Design", joined: "2025-01-15" },
    ];
    const employeeIds: string[] = [];
    for (const e of employees) {
      const row = await db.employee.upsert({
        where: { organizationId_empCode: { organizationId: t.orgId, empCode: e.code } },
        update: { name: e.name, department: e.dept },
        create: {
          id: `sandbox-emp-${t.slug}-${e.code.toLowerCase()}`,
          organizationId: t.orgId,
          empCode: e.code,
          name: e.name,
          department: e.dept,
          jobTitle: "Coordinator",
          joiningDate: new Date(`${e.joined}T00:00:00Z`),
          seedLeaveYear: 2026,
          carryoverDays: t.slug === "acme" ? 5 : -2,
        },
      });
      employeeIds.push(row.id);
    }

    // Attendance is EXCEPTION-ONLY storage: an ordinary working day has no row,
    // so a handful of entries is a fully populated month. Seeded in the CURRENT
    // month so the grid has something in it whenever the sandbox is opened,
    // rather than on a fixed date that goes quiet next year.
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const marks: [string, number, string][] = [
      ["AL", 3, employeeIds[0]],
      ["AL", 4, employeeIds[0]],
      ["SL-F", 10, employeeIds[0]],
      ["WFH", 11, employeeIds[1]],
      ["OD", 14, employeeIds[1]],
    ];
    for (const [code, day, employeeId] of marks) {
      const date = new Date(`${ym}-${String(day).padStart(2, "0")}T00:00:00Z`);
      await db.attendanceEntry.upsert({
        where: { organizationId_employeeId_date: { organizationId: t.orgId, employeeId, date } },
        update: { leaveCodeId: leaveCodes.get(code)! },
        create: {
          organizationId: t.orgId,
          employeeId,
          date,
          leaveCodeId: leaveCodes.get(code)!,
          source: "import",
        },
      });
    }

    // An ORG-scoped standing rule: stores no days at all, which is the whole
    // point of the rule model, and exercises the precedence chain on the grid.
    const ruleId = `sandbox-rule-${t.slug}`;
    await db.attendanceRule.upsert({
      where: { id: ruleId },
      update: { organizationId: t.orgId },
      create: {
        id: ruleId,
        organizationId: t.orgId,
        scope: "ORG",
        leaveCodeId: leaveCodes.get("WFH")!,
        startDate: new Date(`${ym}-18T00:00:00Z`),
        endDate: new Date(`${ym}-20T00:00:00Z`),
        label: `${t.name} remote week`,
      },
    });

    // The SAME date in both orgs with DIFFERENT labels. Each host must show its
    // own; seeing the other tenant's label is the leak.
    for (const h of [
      { date: `${ym}-25`, label: t.slug === "acme" ? "Acme Founders Day" : "Globex Foundation Day" },
      { date: "2026-12-02", label: "UAE National Day" },
    ]) {
      const date = new Date(`${h.date}T00:00:00Z`);
      await db.publicHoliday.upsert({
        where: { organizationId_date: { organizationId: t.orgId, date } },
        update: { label: h.label },
        create: { organizationId: t.orgId, date, label: h.label },
      });
    }
  }

  // ------------------------------------------------------------------
  // TWO SUPER_ADMINs, on purpose. They are the fixture for the boundary
  // fixed on Aug 21 2026, and the sandbox previously had only the wrong one.
  //
  // `canActAsPlatformOperator` has two conditions: the role is SUPER_ADMIN,
  // AND — when PLATFORM_ORG_ID is set — the user belongs to that org. Until
  // this seed there was nowhere for the second condition to execute, so a
  // TENANT's own SUPER_ADMIN was a platform operator: it could read every
  // tenant's logs, enumerate every organisation, browse our repository, and
  // swap the acting org with an x-org-id header. That is not hypothetical —
  // super@sandbox.test below is org-bound to Acme, and that is exactly the
  // account the fix refuses.
  //
  // So the sandbox now seeds a synthetic PLATFORM org (PLATFORM_DECISIONS §3)
  // with no events and no tenant data — it is a home for the operator, not a
  // tenant — and keeps the Acme-bound SUPER_ADMIN as the negative case.
  // `npm run dev:sandbox` sets PLATFORM_ORG_ID to it.
  //
  // It DOES get a TenantDomain, and that is a correction made Aug 21 2026 after
  // tenant-scoped login shipped. This block originally said "no TenantDomain",
  // which was fine while sign-in was global — and became a lockout the moment
  // the lookup started resolving the tenant from the Host: the operator's org
  // matched no domain, so signing in anywhere found nothing and the platform
  // had no door for the person who operates it. The operator signs in on their
  // OWN host, then acts as a tenant through `x-org-id`
  // (`resolveActingOrgId`) — which is the flow that was designed, just never
  // exercised until login became host-bound.
  // ------------------------------------------------------------------
  await db.organization.upsert({
    where: { id: PLATFORM_ORG_ID },
    update: { name: "Sandbox Platform (operator)", slug: "sandbox-platform" },
    create: {
      id: PLATFORM_ORG_ID,
      name: "Sandbox Platform (operator)",
      slug: "sandbox-platform",
      logo: null,
      settings: {},
    },
  });

  // The operator console's host. Without it there is no way to sign in as the
  // operator at all — see the note above.
  await db.tenantDomain.upsert({
    where: { domain: PLATFORM_HOST },
    update: { organizationId: PLATFORM_ORG_ID, isPrimary: true, verifiedAt: new Date() },
    create: {
      domain: PLATFORM_HOST,
      organizationId: PLATFORM_ORG_ID,
      isPrimary: true,
      verifiedAt: new Date(),
    },
  });

  // The REAL operator. Belongs to the platform org, so it satisfies both
  // conditions and keeps every cross-tenant capability.
  await db.user.upsert({
    where: { email: "operator@sandbox.test" },
    update: { role: "SUPER_ADMIN", passwordHash, emailVerified: new Date(), organizationId: PLATFORM_ORG_ID },
    create: {
      email: "operator@sandbox.test",
      firstName: "Platform",
      lastName: "Operator",
      passwordHash,
      role: "SUPER_ADMIN",
      organizationId: PLATFORM_ORG_ID,
      emailVerified: new Date(),
    },
  });

  // The NEGATIVE case: a tenant's own SUPER_ADMIN. Same role, different org,
  // and therefore not an operator. Kept under its original address so the
  // existing sandbox docs and habits still work — what changed is what it can
  // reach, which is now Acme and nothing else.
  await db.user.upsert({
    where: { email: "super@sandbox.test" },
    update: { role: "SUPER_ADMIN", passwordHash, emailVerified: new Date(), organizationId: "sandbox-org-acme" },
    create: {
      email: "super@sandbox.test",
      firstName: "Acme",
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
  for (const t of TENANTS) {
    console.log(`   ${t.host}  registrant portal: delegate@${t.slug}.test / ${PASSWORD}`);
  }
  console.log(`   ${PLATFORM_HOST}  →  operator console (sign in HERE: operator@sandbox.test / ${PASSWORD})`);
  console.log(`   Tenant SUPER_ADMIN (must be REFUSED cross-tenant): super@sandbox.test / ${PASSWORD}  (org: Acme)`);
  console.log(`   Shared public slug: /e/${SHARED_SLUG}  (serves each org's own event by host)`);
  console.log(`   HR (npm run dev:sandbox sets HR_MODULE_ENABLED): /hr`);
  console.log(`     both orgs hold employee E-001 and a holiday on the same date - each host must show its OWN`);
}

main()
  .catch((e) => {
    console.error("sandbox seed failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
