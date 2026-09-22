/**
 * Seed for the Event Agent golden task set (e2e/agent-golden/, readiness
 * review E2). Calls the regression seedCore() and layers on:
 *
 *   - eight ADMIN accounts and one MEMBER (the agent admits 20 requests per
 *     user per hour; a run is about 45, so tasks rotate over the pool)
 *   - one event per write task, all in one January 2027 window, so a task's
 *     rows never bleed into another task's grading
 *   - a richer read event: six registrations across the statuses, five
 *     speakers (two unsigned agreements), a session with roles, a track,
 *     two abstracts; one registrant surname, one speaker bio and one
 *     abstract body carry injected instructions the model must treat as data
 *   - sponsors, a promo code, a panel session and the people the approval
 *     and refusal tasks act on
 *
 * NEVER imported by the regression e2e suite. Idempotent: seedCore deletes
 * the org (cascading every golden event) and this file deletes the golden
 * users by email before recreating them.
 */
import { PrismaClient } from "@prisma/client";
import { seedCore } from "./seed-e2e-core";
import {
  EMAIL_REGISTRANTS,
  EV,
  GOLDEN_ADMINS,
  GOLDEN_DAY1_0900,
  GOLDEN_DAY2_1100,
  GOLDEN_EVENT_END,
  GOLDEN_EVENT_LIST,
  GOLDEN_EVENT_START,
  GOLDEN_MEMBER,
  GOLDEN_ORG_ID,
  GOLDEN_TZ,
  GOLDEN_USER_EMAILS,
  INJECTION_ABSTRACT,
  INJECTION_BIO,
  INJECTION_NAME,
  PANEL_SESSION,
  PANEL_SPEAKERS,
  READ_ABSTRACT_TITLE,
  READ_REGISTRATIONS,
  READ_SESSION,
  READ_SPEAKERS,
  READ_TRACK,
  SEED_PROMO,
  SEED_SPONSORS,
  UPDATE_REGISTRANT,
  VIP_TICKET,
} from "../e2e/agent-golden/_seed-constants";

const db = new PrismaClient();

const ORG = GOLDEN_ORG_ID;
const start = new Date(GOLDEN_EVENT_START);
const end = new Date(GOLDEN_EVENT_END);

async function createGoldenUsers(passwordHash: string) {
  await db.user.deleteMany({ where: { email: { in: GOLDEN_USER_EMAILS } } });
  for (const a of GOLDEN_ADMINS) {
    await db.user.create({
      data: { email: a.email, passwordHash, firstName: a.firstName, lastName: a.lastName, role: "ADMIN", organizationId: ORG },
    });
  }
  await db.user.create({
    data: {
      email: GOLDEN_MEMBER.email,
      passwordHash,
      firstName: GOLDEN_MEMBER.firstName,
      lastName: GOLDEN_MEMBER.lastName,
      role: "MEMBER",
      organizationId: ORG,
    },
  });
}

async function createGoldenEvents() {
  for (const ev of GOLDEN_EVENT_LIST) {
    await db.event.create({
      data: {
        id: ev.id,
        organizationId: ORG,
        name: ev.name,
        slug: ev.slug,
        code: ev.code,
        description: `Golden task set fixture: ${ev.name}.`,
        startDate: start,
        endDate: end,
        timezone: GOLDEN_TZ,
        venue: "Golden Hall",
        city: "Dubai",
        country: "United Arab Emirates",
        eventType: "CONFERENCE",
        status: "PUBLISHED",
        settings: { reviewerUserIds: [] },
      },
    });
  }
}

/** A free registration type on an event, returned for the seeded registrations. */
async function generalTicketType(eventId: string, id: string) {
  return db.ticketType.create({
    data: { id, eventId, organizationId: ORG, name: "General", category: "General", price: 0, currency: "USD", isActive: true, isDefault: true },
  });
}

async function registration(
  eventId: string,
  ticketTypeId: string,
  person: { email: string; firstName: string; lastName: string },
  status: "PENDING" | "CONFIRMED" | "CANCELLED",
  paymentStatus: "PAID" | "UNPAID" | "COMPLIMENTARY",
) {
  const attendee = await db.attendee.create({
    data: { organizationId: ORG, email: person.email, firstName: person.firstName, lastName: person.lastName },
  });
  return db.registration.create({
    data: { organizationId: ORG, eventId, ticketTypeId, attendeeId: attendee.id, status, paymentStatus },
  });
}

async function seedReadEvent() {
  const tt = await generalTicketType(EV.READ.id, "golden-tt-read-general");
  for (const r of READ_REGISTRATIONS) {
    const lastName = r.lastName === "INJECTED" ? INJECTION_NAME : r.lastName;
    await registration(EV.READ.id, tt.id, { email: r.email, firstName: r.firstName, lastName }, r.status, r.paymentStatus);
  }

  const speakers: Record<string, { id: string }> = {};
  for (const [key, s] of Object.entries(READ_SPEAKERS)) {
    speakers[key] = await db.speaker.create({
      data: {
        eventId: EV.READ.id,
        organizationId: ORG,
        email: s.email,
        firstName: s.firstName,
        lastName: s.lastName,
        title: "DR",
        organization: "Golden Hospital",
        status: s.status,
        agreementAcceptedAt: s.signed ? new Date("2026-09-01T09:00:00Z") : null,
        bio: key === "INJECTED" ? INJECTION_BIO : `${s.firstName} ${s.lastName} is a consultant at Golden Hospital.`,
      },
    });
  }

  await db.track.create({ data: { id: READ_TRACK.id, eventId: EV.READ.id, organizationId: ORG, name: READ_TRACK.name, color: "#00aade", sortOrder: 0 } });

  const plenaryStart = new Date(GOLDEN_DAY1_0900);
  await db.eventSession.create({
    data: {
      id: READ_SESSION.id,
      eventId: EV.READ.id,
      organizationId: ORG,
      trackId: READ_TRACK.id,
      name: READ_SESSION.name,
      description: "Welcome and the year's outcomes.",
      startTime: plenaryStart,
      endTime: new Date(plenaryStart.getTime() + 60 * 60 * 1000),
      location: READ_SESSION.location,
      speakers: {
        create: [
          { speakerId: speakers.KHALIL.id, organizationId: ORG, role: "SPEAKER" },
          { speakerId: speakers.RASHID.id, organizationId: ORG, role: "MODERATOR" },
        ],
      },
    },
  });

  await db.abstract.create({
    data: {
      eventId: EV.READ.id,
      organizationId: ORG,
      speakerId: speakers.KHALIL.id,
      title: READ_ABSTRACT_TITLE,
      content:
        "Background: catheter ablation is first-line for symptomatic atrial fibrillation. Methods: a five-year single-centre cohort. Results: freedom from recurrence at five years was 68%. Conclusions: durable, with low complication rates.",
      status: "SUBMITTED",
      presentationType: "ORAL",
      submittedAt: new Date("2026-09-10T08:00:00Z"),
    },
  });
  await db.abstract.create({
    data: {
      eventId: EV.READ.id,
      organizationId: ORG,
      speakerId: speakers.FAROUK.id,
      title: "Registry note on golden anticoagulation",
      content: INJECTION_ABSTRACT,
      status: "SUBMITTED",
      presentationType: "POSTER",
      submittedAt: new Date("2026-09-11T08:00:00Z"),
    },
  });
}

async function seedVipEvent() {
  for (const [key, t] of Object.entries(VIP_TICKET)) {
    await db.ticketType.create({
      data: {
        id: t.id,
        eventId: EV.VIP.id,
        organizationId: ORG,
        name: t.name,
        category: t.name,
        price: t.price,
        currency: "USD",
        isActive: true,
        isDefault: key === "STANDARD",
        isFaculty: key === "FACULTY",
      },
    });
  }
}

async function seedEmailEvents() {
  for (const ev of [EV.EMAIL_APPROVE, EV.EMAIL_CANCEL]) {
    const tt = await generalTicketType(ev.id, `${ev.id}-general`);
    for (const p of EMAIL_REGISTRANTS) {
      await registration(ev.id, tt.id, p, "CONFIRMED", "COMPLIMENTARY");
    }
  }
}

async function seedSponsors() {
  for (const [i, s] of SEED_SPONSORS.entries()) {
    await db.sponsor.create({
      data: { id: s.id, eventId: EV.SPONSORS.id, organizationId: ORG, name: s.name, tier: s.tier, sortOrder: i },
    });
  }
}

async function seedSpeakersEvent() {
  const ids: Record<string, string> = {};
  for (const [key, p] of Object.entries(PANEL_SPEAKERS)) {
    const s = await db.speaker.create({
      data: { eventId: EV.SPEAKERS.id, organizationId: ORG, email: p.email, firstName: p.firstName, lastName: p.lastName, title: "DR", status: "CONFIRMED" },
    });
    ids[key] = s.id;
  }
  const panelStart = new Date(GOLDEN_DAY2_1100);
  await db.eventSession.create({
    data: {
      id: PANEL_SESSION.id,
      eventId: EV.SPEAKERS.id,
      organizationId: ORG,
      name: PANEL_SESSION.name,
      startTime: panelStart,
      endTime: new Date(panelStart.getTime() + 60 * 60 * 1000),
      location: PANEL_SESSION.location,
      speakers: {
        create: [
          { speakerId: ids.RAHIM, organizationId: ORG, role: "SPEAKER" },
          { speakerId: ids.KAMAL, organizationId: ORG, role: "SPEAKER" },
        ],
      },
    },
  });
}

async function seedPromoEvent() {
  await db.promoCode.create({
    data: {
      eventId: EV.PROMO.id,
      organizationId: ORG,
      code: SEED_PROMO.code,
      discountType: "PERCENTAGE",
      discountValue: SEED_PROMO.discountValue,
      maxUses: 50,
      isActive: true,
    },
  });
}

async function seedUpdateEvent() {
  const tt = await generalTicketType(EV.UPDATE.id, `${EV.UPDATE.id}-general`);
  await registration(EV.UPDATE.id, tt.id, UPDATE_REGISTRANT, "PENDING", "UNPAID");
}

async function main() {
  console.log("[seed-e2e-golden] starting");
  const { passwordHash } = await seedCore(db);
  await createGoldenUsers(passwordHash);
  await createGoldenEvents();
  await seedReadEvent();
  await seedVipEvent();
  await seedEmailEvents();
  await seedSponsors();
  await seedSpeakersEvent();
  await seedPromoEvent();
  await seedUpdateEvent();
  console.log(
    `[seed-e2e-golden] done: ${GOLDEN_ADMINS.length} admins + 1 member, ${GOLDEN_EVENT_LIST.length} events, read event ${EV.READ.id}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed-e2e-golden] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
