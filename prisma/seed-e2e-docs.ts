/**
 * Documentation-only seed — calls the regular seedCore() and layers on
 * the fixtures the manual screenshots need:
 *
 *   - extra speakers (CONFIRMED + signed agreement) for IMG-005
 *   - track + session with topics + speaker assignment for IMG-006/008/009
 *   - hotel + room types + accommodation booking for IMG-013/014
 *   - review criteria + an UNDER_REVIEW abstract for IMG-015/016
 *   - promo codes for IMG-010
 *   - a second WEBINAR-typed event with attendance + polls + Q&A
 *     for IMG-023/024
 *
 * NEVER imported by the regression e2e suite. The regular `npm run test:e2e`
 * uses prisma/seed-e2e.ts which calls only seedCore() and stays minimal.
 */
import { PrismaClient } from "@prisma/client";
import { seedCore } from "./seed-e2e-core";
import {
  ORG_ID,
  EVENT_ID,
  EVENT_SLUG,
  FREE_CATEGORY_SLUG,
  DOCS_SESSION_ID,
  DOCS_TRACK_ID,
  DOCS_ABSTRACT_ID,
  DOCS_HOTEL_ID,
  DOCS_ROOM_TYPE_ID,
  DOCS_WEBINAR_EVENT_ID,
  DOCS_WEBINAR_SLUG,
} from "../e2e/fixtures/seed-constants";

const db = new PrismaClient();

async function seedExtras(createdUsers: Record<string, string>) {
  // ── Track + session with topics + speaker assignment ───────────────────────
  await db.track.create({
    data: {
      id: DOCS_TRACK_ID,
      eventId: EVENT_ID,
      name: "Clinical Track",
      color: "#00aade",
      sortOrder: 0,
    },
  });

  // Two extra speakers with realistic names so the assignment panel
  // shows a populated list.
  const speakerA = await db.speaker.create({
    data: {
      eventId: EVENT_ID,
      email: "dr.amani@example.com",
      title: "DR",
      firstName: "Amani",
      lastName: "Khalil",
      organization: "Tawam Hospital",
      jobTitle: "Consultant Cardiologist",
      country: "United Arab Emirates",
      bio: "Consultant Cardiologist with 15+ years of clinical experience.",
      status: "CONFIRMED",
      agreementAcceptedAt: new Date(),
    },
  });
  const speakerB = await db.speaker.create({
    data: {
      eventId: EVENT_ID,
      email: "prof.lewis@example.com",
      title: "PROF",
      firstName: "Daniel",
      lastName: "Lewis",
      organization: "Imperial College London",
      jobTitle: "Professor of Medicine",
      country: "United Kingdom",
      bio: "Professor of Internal Medicine and academic researcher.",
      status: "CONFIRMED",
    },
  });

  const event = await db.event.findUniqueOrThrow({ where: { id: EVENT_ID } });
  const sessionStart = new Date(event.startDate.getTime() + 9 * 60 * 60 * 1000);
  const sessionEnd = new Date(sessionStart.getTime() + 60 * 60 * 1000);

  await db.eventSession.create({
    data: {
      id: DOCS_SESSION_ID,
      eventId: EVENT_ID,
      trackId: DOCS_TRACK_ID,
      name: "Opening Keynote — Future of Cardiology",
      description: "Welcome address followed by keynote on emerging trends in interventional cardiology.",
      startTime: sessionStart,
      endTime: sessionEnd,
      location: "Main Hall",
      capacity: 200,
      speakers: {
        create: [
          { speakerId: speakerA.id, role: "SPEAKER" },
          { speakerId: speakerB.id, role: "MODERATOR" },
        ],
      },
      topics: {
        create: [
          { title: "Welcome and event overview", sortOrder: 0, duration: 15 },
          { title: "Emerging trends in interventional cardiology", sortOrder: 1, duration: 30 },
          { title: "Panel discussion + Q&A", sortOrder: 2, duration: 15 },
        ],
      },
    },
  });

  // ── Hotel + room types + booking ──────────────────────────────────────────
  await db.hotel.create({
    data: {
      id: DOCS_HOTEL_ID,
      eventId: EVENT_ID,
      name: "JW Marriott Marquis Dubai",
      address: "Sheikh Zayed Rd, Business Bay, Dubai",
      stars: 5,
      contactEmail: "events@marriottdubai.test",
      contactPhone: "+971 4 414 0000",
      isActive: true,
      roomTypes: {
        create: [
          {
            id: DOCS_ROOM_TYPE_ID,
            name: "Deluxe King",
            description: "Deluxe King with city view.",
            pricePerNight: 850,
            currency: "USD",
            totalRooms: 30,
            bookedRooms: 1,
            capacity: 2,
          },
          {
            name: "Executive Suite",
            description: "Executive Suite with separate living area.",
            pricePerNight: 1450,
            currency: "USD",
            totalRooms: 10,
            bookedRooms: 0,
            capacity: 2,
          },
        ],
      },
    },
  });

  // Find the seeded registrant's registration to attach an accommodation.
  const reg = await db.registration.findFirst({
    where: { eventId: EVENT_ID },
    select: { id: true },
  });
  if (reg) {
    const checkIn = new Date(event.startDate);
    const checkOut = new Date(event.endDate);
    const nights = Math.max(
      1,
      Math.round((checkOut.getTime() - checkIn.getTime()) / (24 * 60 * 60 * 1000)),
    );
    await db.accommodation.create({
      data: {
        eventId: EVENT_ID,
        registrationId: reg.id,
        roomTypeId: DOCS_ROOM_TYPE_ID,
        checkIn,
        checkOut,
        guestCount: 1,
        totalPrice: 850 * nights,
        currency: "USD",
        status: "CONFIRMED",
      },
    });
  }

  // ── Review criteria + abstract under review ───────────────────────────────
  await db.reviewCriterion.create({
    data: {
      eventId: EVENT_ID,
      name: "Scientific Novelty",
      weight: 8,
      sortOrder: 0,
    },
  });
  await db.reviewCriterion.create({
    data: {
      eventId: EVENT_ID,
      name: "Clinical Relevance",
      weight: 9,
      sortOrder: 1,
    },
  });
  await db.reviewCriterion.create({
    data: {
      eventId: EVENT_ID,
      name: "Presentation Quality",
      weight: 7,
      sortOrder: 2,
    },
  });

  const submitterSpeaker = await db.speaker.findFirstOrThrow({
    where: { eventId: EVENT_ID, userId: createdUsers.SUBMITTER },
    select: { id: true },
  });

  await db.abstract.create({
    data: {
      id: DOCS_ABSTRACT_ID,
      eventId: EVENT_ID,
      speakerId: submitterSpeaker.id,
      title: "Catheter ablation outcomes in atrial fibrillation: a 5-year follow-up",
      content:
        "Background: Catheter ablation has emerged as a primary therapy for symptomatic atrial fibrillation. " +
        "We report 5-year outcomes from a single-centre cohort of 412 patients undergoing radiofrequency ablation. " +
        "Methods: Retrospective review of consecutive procedures between 2019 and 2024. " +
        "Results: Freedom from atrial fibrillation at 5 years was 68%. " +
        "Conclusions: Long-term outcomes remain favourable, with low complication rates.",
      status: "UNDER_REVIEW",
      presentationType: "ORAL",
    },
  });

  // ── Promo codes ──────────────────────────────────────────────────────────
  await db.promoCode.create({
    data: {
      eventId: EVENT_ID,
      code: "EARLYBIRD20",
      description: "Early bird 20% off",
      discountType: "PERCENTAGE",
      discountValue: 20,
      maxUses: 100,
      usedCount: 12,
      isActive: true,
      validFrom: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  await db.promoCode.create({
    data: {
      eventId: EVENT_ID,
      code: "FACULTY100",
      description: "Faculty members — full waiver",
      discountType: "FIXED_AMOUNT",
      discountValue: 100,
      maxUses: null,
      usedCount: 4,
      isActive: true,
    },
  });

  // ── WEBINAR event for IMG-023/024 ─────────────────────────────────────────
  const webinarStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const webinarEnd = new Date(webinarStart.getTime() + 90 * 60 * 1000);

  await db.event.create({
    data: {
      id: DOCS_WEBINAR_EVENT_ID,
      organizationId: ORG_ID,
      name: "Heart Failure Webinar — April 2026",
      slug: DOCS_WEBINAR_SLUG,
      description: "Quarterly cardiology webinar series.",
      startDate: webinarStart,
      endDate: webinarEnd,
      timezone: "Asia/Dubai",
      eventType: "WEBINAR",
      status: "COMPLETED",
      settings: { webinar: { provisioned: true } },
    },
  });

  // Anchor session for the webinar.
  const anchorSession = await db.eventSession.create({
    data: {
      eventId: DOCS_WEBINAR_EVENT_ID,
      name: "Heart Failure Webinar — Live Session",
      startTime: webinarStart,
      endTime: webinarEnd,
      location: "Online (Zoom)",
    },
  });

  // ZoomMeeting linked to the anchor session.
  const zoomMeeting = await db.zoomMeeting.create({
    data: {
      sessionId: anchorSession.id,
      eventId: DOCS_WEBINAR_EVENT_ID,
      meetingType: "WEBINAR",
      zoomMeetingId: "85912345678",
      joinUrl: "https://zoom.us/w/85912345678",
      passcode: "demo",
      duration: 90,
      recordingStatus: "AVAILABLE",
      recordingFetchedAt: new Date(),
      recordingUrl: "https://zoom.us/rec/share/example",
      recordingDuration: 5400,
    },
  });

  // Attendance — 240 registered / 187 attended is the canonical demo split.
  const attendees = [
    { name: "Reg Registrant", email: "registrant@test.local", durationSeconds: 5100 },
    { name: "Sam Submitter", email: "submitter@test.local", durationSeconds: 4920 },
    { name: "Olga Organizer", email: "organizer@test.local", durationSeconds: 5400 },
    { name: "Riley Reviewer", email: "reviewer@test.local", durationSeconds: 3300 },
    { name: "Dr. Amani Khalil", email: "dr.amani@example.com", durationSeconds: 5400 },
    { name: "Prof. Daniel Lewis", email: "prof.lewis@example.com", durationSeconds: 4710 },
    { name: "Lina Saad", email: "lina.saad@example.com", durationSeconds: 2480 },
    { name: "Marcus Chen", email: "marcus.chen@example.com", durationSeconds: 5100 },
  ];
  for (const [i, a] of attendees.entries()) {
    await db.zoomAttendance.create({
      data: {
        zoomMeetingId: zoomMeeting.id,
        eventId: DOCS_WEBINAR_EVENT_ID,
        sessionId: anchorSession.id,
        zoomParticipantId: `pid-${i}`,
        name: a.name,
        email: a.email,
        joinTime: new Date(webinarStart.getTime() + i * 30_000),
        leaveTime: new Date(webinarStart.getTime() + a.durationSeconds * 1000),
        durationSeconds: a.durationSeconds,
        attentivenessScore: Math.round(80 + Math.random() * 15),
      },
    });
  }

  // Webinar poll with responses.
  const poll = await db.webinarPoll.create({
    data: {
      zoomMeetingId: zoomMeeting.id,
      title: "Live audience poll",
      questions: [
        {
          name: "How often do you encounter atrial fibrillation in clinic?",
          type: "single",
          answers: ["Daily", "Weekly", "Monthly", "Rarely"],
        },
      ],
    },
  });
  const pollAnswerCounts = { Daily: 4, Weekly: 2, Monthly: 1, Rarely: 1 };
  let respIdx = 0;
  for (const [answer, count] of Object.entries(pollAnswerCounts)) {
    for (let i = 0; i < count; i++) {
      await db.webinarPollResponse.create({
        data: {
          pollId: poll.id,
          participantName: `Participant ${respIdx + 1}`,
          participantEmail: `p${respIdx + 1}@example.com`,
          answers: { "How often do you encounter atrial fibrillation in clinic?": answer },
          submittedAt: new Date(webinarStart.getTime() + (respIdx + 1) * 30_000),
        },
      });
      respIdx++;
    }
  }

  // Q&A entries.
  const questions = [
    {
      asker: "Dr. Amani Khalil",
      email: "dr.amani@example.com",
      question: "What's the cutoff for considering ablation in young patients?",
      answer: "We typically consider ablation after one failed antiarrhythmic, irrespective of age.",
      answeredBy: "Prof. Daniel Lewis",
    },
    {
      asker: "Lina Saad",
      email: "lina.saad@example.com",
      question: "Any guidance on anticoagulation post-ablation in low CHA2DS2-VASc patients?",
      answer: "Continue OAC for at least 2 months; reassess based on symptoms and monitoring.",
      answeredBy: "Prof. Daniel Lewis",
    },
    {
      asker: "Marcus Chen",
      email: "marcus.chen@example.com",
      question: "What recurrence rate should we counsel patients on at 5 years?",
      answer: null,
      answeredBy: null,
    },
  ];
  for (const [i, q] of questions.entries()) {
    await db.webinarQuestion.create({
      data: {
        zoomMeetingId: zoomMeeting.id,
        askerName: q.asker,
        askerEmail: q.email,
        question: q.question,
        answer: q.answer,
        answeredByName: q.answeredBy,
        askedAt: new Date(webinarStart.getTime() + (i + 1) * 60_000),
      },
    });
  }
}

async function main() {
  console.log("[seed-e2e-docs] starting");
  const { createdUsers } = await seedCore(db);
  await seedExtras(createdUsers);
  console.log(
    `[seed-e2e-docs] done — org=${ORG_ID} event=${EVENT_ID} slug=${EVENT_SLUG} category=${FREE_CATEGORY_SLUG} webinar=${DOCS_WEBINAR_SLUG}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed-e2e-docs] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
