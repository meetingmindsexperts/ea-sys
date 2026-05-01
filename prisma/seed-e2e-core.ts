/**
 * Shared core seed logic — populates the org, baseline users, the canonical
 * test event, two ticket types, the submitter speaker, and the registrant
 * registration. Used by:
 *   - prisma/seed-e2e.ts        (regression e2e suite)
 *   - prisma/seed-e2e-docs.ts   (screenshot capture, layers extras on top)
 *
 * Idempotent: deletes the fixed-ID org (cascades) and the fixed-email users
 * before recreating, so it's safe to re-run against the same DB.
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
  USERS,
  DEFAULT_PASSWORD,
} from "../e2e/fixtures/seed-constants";

export interface SeedCoreResult {
  createdUsers: Record<string, string>;
  passwordHash: string;
}

export async function seedCore(db: PrismaClient): Promise<SeedCoreResult> {
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
            description: "Paid attendance.",
            price: 100,
            currency: "USD",
            isActive: true,
          },
        ],
      },
      abstractThemes: { create: [{ name: "General" }] },
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

  return { createdUsers, passwordHash };
}
