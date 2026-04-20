/**
 * Deterministic seed for Playwright E2E tests.
 *
 * Runs against DATABASE_URL (expected to point at the test DB — see
 * playwright.config.ts, which passes DATABASE_URL_TEST through as DATABASE_URL).
 * Idempotent: deletes the fixed-ID org (cascades) and recreates it.
 *
 * Fixed IDs / emails / passwords live in e2e/fixtures/seed-constants.ts so
 * specs and seed can't drift apart.
 */
import bcrypt from "bcryptjs";
import { PrismaClient, type UserRole } from "@prisma/client";
import {
  ORG_ID,
  EVENT_ID,
  EVENT_SLUG,
  FREE_TICKET_TYPE_ID,
  PAID_TICKET_TYPE_ID,
  FREE_PRICING_TIER_ID,
  FREE_CATEGORY_SLUG,
  USERS,
  DEFAULT_PASSWORD,
} from "../e2e/fixtures/seed-constants";

const db = new PrismaClient();

async function main() {
  console.log("[seed-e2e] starting");

  await db.organization.deleteMany({ where: { id: ORG_ID } });
  await db.user.deleteMany({ where: { email: { in: USERS.map((u) => u.email) } } });

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  await db.organization.create({
    data: {
      id: ORG_ID,
      name: "E2E Test Org",
      slug: "e2e-test-org",
      primaryColor: "#00aade",
    },
  });

  const now = new Date();
  const startDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  await db.event.create({
    data: {
      id: EVENT_ID,
      organizationId: ORG_ID,
      name: "E2E Test Event",
      slug: EVENT_SLUG,
      description: "Event used by the Playwright E2E suite.",
      startDate,
      endDate,
      timezone: "Asia/Dubai",
      venue: "E2E Venue",
      city: "Dubai",
      country: "United Arab Emirates",
      eventType: "CONFERENCE",
      status: "PUBLISHED",
      settings: { allowAbstractSubmissions: true, reviewerUserIds: [] },
      registrationWelcomeHtml: "<p>Welcome to the E2E test event.</p>",
      registrationTermsHtml: "<p>Test terms and conditions.</p>",
      abstractWelcomeHtml: "<p>Welcome abstract submitters.</p>",
      ticketTypes: {
        create: [
          {
            id: FREE_TICKET_TYPE_ID,
            name: "Free Pass",
            category: "Free Pass",
            description: "Complimentary general attendance.",
            price: 0,
            currency: "USD",
            isActive: true,
            isDefault: true,
            // Seed a tier so both tier-based and legacy (non-tier) flows are
            // represented; the legacy path is also covered because the
            // pricingTierId zod now accepts "" → undefined.
            pricingTiers: {
              create: [
                {
                  id: FREE_PRICING_TIER_ID,
                  name: "Free Pass",
                  price: 0,
                  currency: "USD",
                  isActive: true,
                },
              ],
            },
          },
          {
            id: PAID_TICKET_TYPE_ID,
            name: "Standard",
            category: "Standard",
            description: "Paid attendance (unused this round).",
            price: 100,
            currency: "USD",
            isActive: true,
          },
        ],
      },
      abstractThemes: {
        create: [{ name: "General" }],
      },
    },
  });

  const roleToData: Record<string, { role: UserRole; organizationId: string | null }> = {
    ADMIN: { role: "ADMIN", organizationId: ORG_ID },
    ORGANIZER: { role: "ORGANIZER", organizationId: ORG_ID },
    REVIEWER: { role: "REVIEWER", organizationId: null },
    SUBMITTER: { role: "SUBMITTER", organizationId: null },
    REGISTRANT: { role: "REGISTRANT", organizationId: null },
  };

  const createdUsers: Record<string, string> = {};
  for (const u of USERS) {
    const meta = roleToData[u.role];
    const user = await db.user.create({
      data: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        role: meta.role,
        organizationId: meta.organizationId,
      },
    });
    createdUsers[u.role] = user.id;
  }

  await db.event.update({
    where: { id: EVENT_ID },
    data: {
      settings: {
        allowAbstractSubmissions: true,
        reviewerUserIds: [createdUsers.REVIEWER],
      },
    },
  });

  await db.speaker.create({
    data: {
      eventId: EVENT_ID,
      userId: createdUsers.SUBMITTER,
      email: USERS.find((u) => u.role === "SUBMITTER")!.email,
      firstName: "Sam",
      lastName: "Submitter",
      status: "INVITED",
    },
  });

  const registrant = USERS.find((u) => u.role === "REGISTRANT")!;
  const registrantAttendee = await db.attendee.create({
    data: {
      email: registrant.email,
      firstName: registrant.firstName,
      lastName: registrant.lastName,
    },
  });
  await db.registration.create({
    data: {
      eventId: EVENT_ID,
      ticketTypeId: FREE_TICKET_TYPE_ID,
      attendeeId: registrantAttendee.id,
      userId: createdUsers.REGISTRANT,
      status: "CONFIRMED",
      paymentStatus: "COMPLIMENTARY",
    },
  });

  console.log(`[seed-e2e] done — org=${ORG_ID} event=${EVENT_ID} slug=${EVENT_SLUG} category=${FREE_CATEGORY_SLUG}`);
}

main()
  .catch((err) => {
    console.error("[seed-e2e] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
