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
  ATTENDEE_A_ID,
  ATTENDEE_B_ID,
  REG_A_ID,
  REG_B_ID,
  INVOICE_A_ID,
  INVOICE_A_NUMBER,
  INVOICE_B_ID,
  INVOICE_B_NUMBER,
  INVOICE_B_ONLY_ID,
  INVOICE_B_ONLY_NUMBER,
  SHARED_ATTENDEE_EMAIL,
  PAYMENT_A_ID,
  PAYMENT_A_STRIPE_PI,
  PAYMENT_B_ID,
  PAYMENT_B_STRIPE_PI,
  REFUND_ATTEMPT_A_ID,
  REFUND_ATTEMPT_B_ID,
  TICKET_TYPE_A_ID,
  TICKET_TYPE_B_ID,
  PRICING_TIER_A_ID,
  PRICING_TIER_B_ID,
  SHARED_PROMO_CODE,
  PROMO_CODE_A_ID,
  PROMO_CODE_B_ID,
  PROMO_REDEMPTION_A_ID,
  PROMO_REDEMPTION_B_ID,
  PROMO_LINK_A_ID,
  PROMO_LINK_B_ID,
  SHARED_SPEAKER_EMAIL,
  SPEAKER_A_ID,
  SPEAKER_B_ID,
  SPEAKER_DOC_A_ID,
  SPEAKER_DOC_B_ID,
  ORG_B_ONLY_SPEAKER_EMAIL,
  SPEAKER_B_ONLY_ID,
  SHARED_HOTEL_NAME,
  HOTEL_A_ID,
  HOTEL_B_ID,
  ROOMTYPE_A_ID,
  ROOMTYPE_B_ID,
  ACCOMMODATION_A_ID,
  ACCOMMODATION_B_ID,
  SHARED_ABSTRACT_THEME_NAME,
  ABSTRACT_A_ID,
  ABSTRACT_B_ID,
  ABSTRACT_THEME_A_ID,
  ABSTRACT_THEME_B_ID,
  REVIEW_CRITERION_A_ID,
  REVIEW_CRITERION_B_ID,
  ABSTRACT_REVIEWER_A_ID,
  ABSTRACT_REVIEWER_B_ID,
  ABSTRACT_SUBMISSION_A_ID,
  ABSTRACT_SUBMISSION_B_ID,
  TRACK_A_ID,
  TRACK_B_ID,
  SESSION_A_ID,
  SESSION_B_ID,
  SESSION_TOPIC_A_ID,
  SESSION_TOPIC_B_ID,
  SHARED_CRM_EMAIL_KEY,
  CRM_CT_A_SHARED_ID,
  CRM_CT_B_SHARED_ID,
  ORG_B_ONLY_CRM_EMAIL_KEY,
  CRM_CT_B_ONLY_ID,
  CRM_CO_A_ID,
  CRM_CO_B_ID,
  CRM_PROD_A_ID,
  CRM_PROD_B_ID,
  CRM_STAGE_A_ID,
  CRM_STAGE_B_ID,
  CRM_TPL_A_ID,
  CRM_TPL_B_ID,
  CRM_CLAIM_A_ID,
  CRM_CLAIM_B_ID,
  CRM_NOTIF_A_ID,
  CRM_NOTIF_B_ID,
  CRM_ACT_A_ID,
  CRM_ACT_B_ID,
  CRM_TASK_A_ID,
  CRM_TASK_B_ID,
  CRM_NOTE_A_ID,
  CRM_NOTE_B_ID,
  CRM_DEALTYPE_A_ID,
  CRM_DEALTYPE_B_ID,
  CRM_DEAL_A_ID,
  CRM_DEAL_B_ID,
  CRM_DC_A_ID,
  CRM_DC_B_ID,
  CRM_DP_A_ID,
  CRM_DP_B_ID,
  CRM_DOC_A_ID,
  CRM_DOC_B_ID,
  CRM_THREAD_A_ID,
  CRM_THREAD_B_ID,
  CRM_THREAD_A_TOKEN,
  CRM_THREAD_B_TOKEN,
  CRM_MSG_A_ID,
  CRM_MSG_B_ID,
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
  invoicing?: {
    eventId: string;
    attendeeId: string;
    registrationId: string;
    invoices: { id: string; number: string; seq: number }[];
    // Registration-core sweep (#8) riders on the same chain.
    payment?: { id: string; stripePaymentId: string };
    refundAttemptId?: string;
    // Ticketing follow-on sweep riders on the same chain.
    ticketing?: {
      ticketTypeId: string;
      pricingTierId: string;
      promoCodeId: string;
      promoCode: string;
      redemptionId: string;
      linkId: string;
    };
  },
  crmContacts: { id: string; emailKey: string }[] = [],
  speakers: { id: string; email: string; docId: string; eventId: string }[] = [],
  // Accommodation sweep (Domain #10): one Hotel → RoomType → Accommodation chain
  // per org, the accommodation hung on this org's own registration.
  accommodation?: {
    hotelId: string;
    hotelName: string;
    roomTypeId: string;
    accommodationId: string;
    eventId: string;
    registrationId: string;
  },
  // Abstract sweep (Domain #11): one Abstract (+ theme, criterion, reviewer,
  // submission) per org. The reviewer is the org's uploader User (org-independent
  // in prod, but here just a convenient existing User row); the ROWs belong to
  // the abstract's event's org.
  abstract?: {
    abstractId: string;
    themeId: string;
    themeName: string;
    criterionId: string;
    reviewerId: string;
    submissionId: string;
    eventId: string;
    speakerId: string;
    reviewerUserId: string;
  },
  // Sessions/Tracks sweep (Domain #12): one Track → EventSession → SessionTopic
  // chain per org, with a SessionSpeaker + TopicSpeaker linking the org's speaker.
  session?: {
    trackId: string;
    sessionId: string;
    topicId: string;
    eventId: string;
    speakerId: string;
  },
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
  // Invoice sweep fixtures. Invoice → Registration → Attendee chain. The
  // Registration cascades from the Event (org cascade reaches it); the Invoice
  // cascades from the Registration. The Attendee is the PARENT of Registration
  // and does NOT cascade — main() cleans it explicitly.
  //
  // Registration-core sweep (#8): the chain is org-stamped, BOTH orgs'
  // attendees share ONE email (Attendee.email is not unique — proves the
  // orphan-reuse-shaped unscoped by-email lookup is lane-scoped), and each
  // org hangs a Payment + RefundAttempt + serial-counter row off it.
  if (invoicing) {
    await db.attendee.create({
      data: {
        id: invoicing.attendeeId,
        organizationId: orgId,
        email: SHARED_ATTENDEE_EMAIL,
        firstName: "Tenancy",
        lastName: "Invoicee",
      },
    });
    await db.registration.create({
      data: {
        id: invoicing.registrationId,
        eventId: invoicing.eventId,
        organizationId: orgId,
        attendeeId: invoicing.attendeeId,
      },
    });
    await db.registrationSerialCounter.create({
      data: { eventId: invoicing.eventId, organizationId: orgId, lastSerial: 1 },
    });
    if (invoicing.payment) {
      await db.payment.create({
        data: {
          id: invoicing.payment.id,
          registrationId: invoicing.registrationId,
          organizationId: orgId,
          amount: 100,
          currency: "USD",
          status: "PAID",
          stripePaymentId: invoicing.payment.stripePaymentId,
        },
      });
    }
    if (invoicing.refundAttemptId) {
      await db.refundAttempt.create({
        data: {
          id: invoicing.refundAttemptId,
          registrationId: invoicing.registrationId,
          organizationId: orgId,
          amount: 10,
          refundedBefore: 0,
          refundedAfter: 10,
          kind: "manual",
          status: "PENDING",
        },
      });
    }
    for (const inv of invoicing.invoices) {
      await db.invoice.create({
        data: {
          id: inv.id,
          organizationId: orgId,
          eventId: invoicing.eventId,
          registrationId: invoicing.registrationId,
          type: "INVOICE",
          invoiceNumber: inv.number,
          sequenceNumber: inv.seq,
          subtotal: 100,
          total: 100,
          currency: "USD",
        },
      });
    }
    // Ticketing follow-on fixtures: TicketType → PricingTier on the event, a
    // PromoCode (shared code string across orgs), a PromoCodeRedemption on this
    // org's registration, and a PromoCodeTicketType link. All org-cascade from
    // the Event (TicketType/PromoCode) or their parents.
    if (invoicing.ticketing) {
      const t = invoicing.ticketing;
      await db.ticketType.create({
        data: {
          id: t.ticketTypeId,
          eventId: invoicing.eventId,
          organizationId: orgId,
          name: "Delegate",
          pricingTiers: {
            create: [
              {
                id: t.pricingTierId,
                organizationId: orgId,
                name: "Early Bird",
                price: 100,
              },
            ],
          },
        },
      });
      await db.promoCode.create({
        data: {
          id: t.promoCodeId,
          eventId: invoicing.eventId,
          organizationId: orgId,
          code: t.promoCode,
          discountType: "PERCENTAGE",
          discountValue: 10,
        },
      });
      await db.promoCodeTicketType.create({
        data: {
          id: t.linkId,
          organizationId: orgId,
          promoCodeId: t.promoCodeId,
          ticketTypeId: t.ticketTypeId,
        },
      });
      await db.promoCodeRedemption.create({
        data: {
          id: t.redemptionId,
          organizationId: orgId,
          promoCodeId: t.promoCodeId,
          registrationId: invoicing.registrationId,
          email: SHARED_ATTENDEE_EMAIL,
          originalPrice: 100,
          discountAmount: 10,
          finalPrice: 90,
        },
      });
    }
  }
  // Speaker sweep fixtures. Speaker cascades from Event (org cascade reaches
  // it); SpeakerDocument cascades from Speaker — no explicit teardown needed.
  // Both userId + sourceRegistrationId left null (independent speakers).
  for (const sp of speakers) {
    await db.speaker.create({
      data: {
        id: sp.id,
        eventId: sp.eventId,
        organizationId: orgId,
        email: sp.email,
        firstName: "Tenancy",
        lastName: `Speaker ${sp.id}`,
      },
    });
    await db.speakerDocument.create({
      data: {
        id: sp.docId,
        speakerId: sp.id,
        organizationId: orgId,
        kind: "SIGNED_AGREEMENT",
        url: `/uploads/speaker-docs/${sp.eventId}/${sp.docId}.pdf`,
        filename: "signed-agreement.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    });
  }
  // Accommodation sweep fixtures. Hotel/RoomType/Accommodation all cascade from
  // Event (org cascade reaches them). The accommodation hangs on this org's own
  // registration (created in the invoicing block above), so it runs after it.
  if (accommodation) {
    await db.hotel.create({
      data: {
        id: accommodation.hotelId,
        eventId: accommodation.eventId,
        organizationId: orgId,
        name: accommodation.hotelName,
      },
    });
    await db.roomType.create({
      data: {
        id: accommodation.roomTypeId,
        hotelId: accommodation.hotelId,
        organizationId: orgId,
        name: "Standard Room",
        pricePerNight: 100,
        currency: "USD",
        capacity: 2,
        totalRooms: 10,
        bookedRooms: 1,
      },
    });
    await db.accommodation.create({
      data: {
        id: accommodation.accommodationId,
        eventId: accommodation.eventId,
        organizationId: orgId,
        registrationId: accommodation.registrationId,
        roomTypeId: accommodation.roomTypeId,
        checkIn: new Date("2027-01-10T14:00:00Z"),
        checkOut: new Date("2027-01-12T11:00:00Z"),
        guestCount: 1,
        totalPrice: 200,
        currency: "USD",
        status: "PENDING",
      },
    });
  }
  // Abstract sweep fixtures. Abstract/AbstractTheme/ReviewCriterion cascade from
  // Event; AbstractReviewer/AbstractReviewSubmission from Abstract. Runs after the
  // speaker + uploader User exist (both seeded above).
  if (abstract) {
    await db.abstractTheme.create({
      data: {
        id: abstract.themeId,
        eventId: abstract.eventId,
        organizationId: orgId,
        name: abstract.themeName,
      },
    });
    await db.reviewCriterion.create({
      data: {
        id: abstract.criterionId,
        eventId: abstract.eventId,
        organizationId: orgId,
        name: "Originality",
        weight: 50,
      },
    });
    await db.abstract.create({
      data: {
        id: abstract.abstractId,
        eventId: abstract.eventId,
        organizationId: orgId,
        speakerId: abstract.speakerId,
        themeId: abstract.themeId,
        title: "Tenancy Abstract",
        content: "Abstract body for the tenancy harness.",
        status: "SUBMITTED",
      },
    });
    await db.abstractReviewer.create({
      data: {
        id: abstract.reviewerId,
        abstractId: abstract.abstractId,
        organizationId: orgId,
        userId: abstract.reviewerUserId,
        assignedById: abstract.reviewerUserId,
      },
    });
    await db.abstractReviewSubmission.create({
      data: {
        id: abstract.submissionId,
        abstractId: abstract.abstractId,
        organizationId: orgId,
        reviewerUserId: abstract.reviewerUserId,
        abstractReviewerId: abstract.reviewerId,
        overallScore: 80,
      },
    });
  }
  // Sessions/Tracks sweep fixtures. Track/EventSession cascade from Event;
  // SessionTopic/SessionSpeaker/TopicSpeaker from EventSession/SessionTopic. Runs
  // after the speaker exists (seeded above).
  if (session) {
    await db.track.create({
      data: { id: session.trackId, eventId: session.eventId, organizationId: orgId, name: "Tenancy Track" },
    });
    await db.eventSession.create({
      data: {
        id: session.sessionId,
        eventId: session.eventId,
        organizationId: orgId,
        trackId: session.trackId,
        name: "Tenancy Session",
        startTime: new Date("2027-01-10T10:00:00Z"),
        endTime: new Date("2027-01-10T11:00:00Z"),
      },
    });
    await db.sessionSpeaker.create({
      data: { sessionId: session.sessionId, speakerId: session.speakerId, organizationId: orgId, role: "SPEAKER" },
    });
    await db.sessionTopic.create({
      data: { id: session.topicId, sessionId: session.sessionId, organizationId: orgId, title: "Tenancy Topic" },
    });
    await db.topicSpeaker.create({
      data: { topicId: session.topicId, speakerId: session.speakerId, organizationId: orgId },
    });
  }
  // CrmContact policy-pass fixtures (all FKs nullable — org cascade wipes them).
  for (const cc of crmContacts) {
    await db.crmContact.create({
      data: {
        id: cc.id,
        organizationId: orgId,
        firstName: "Tenancy",
        lastName: `CrmContact ${cc.id}`,
        email: cc.emailKey,
        emailKey: cc.emailKey,
      },
    });
  }
}

/**
 * CRM full-domain sweep — Group 1 policy-layer fixtures. One flat row per simple
 * direct-org Crm* model. Shared literal values where a per-org unique exists
 * (proves per-org coexistence); the ids differ per org so B's row is A's
 * cross-tenant target. All rows cascade from Organization; the notification's
 * required userId points at the org's uploader User (onDelete Cascade). Called
 * AFTER seedOrg so that uploader already exists.
 */
async function seedCrmGroup1(
  orgId: string,
  userId: string,
  ids: {
    companyId: string;
    productId: string;
    stageId: string;
    templateId: string;
    sendClaimId: string;
    notificationId: string;
    activityId: string;
    taskId: string;
    noteId: string;
    dealTypeId: string;
  },
) {
  await db.crmCompany.create({
    data: { id: ids.companyId, organizationId: orgId, name: "Shared CRM Co", nameKey: "shared crm co" },
  });
  await db.crmProduct.create({
    data: { id: ids.productId, organizationId: orgId, name: "Shared Product", category: "Sponsorship", sku: "SHARED-SKU" },
  });
  await db.crmPipelineStage.create({
    data: { id: ids.stageId, organizationId: orgId, name: "Shared Stage", sortOrder: 0 },
  });
  await db.crmEmailTemplate.create({
    data: { id: ids.templateId, organizationId: orgId, name: "Shared Template", subject: "Hi", body: "Body" },
  });
  // PK is organizationId — one counter row per org, no separate id.
  await db.crmQuoteCounter.create({ data: { organizationId: orgId } });
  await db.crmEmailSendClaim.create({
    data: { id: ids.sendClaimId, organizationId: orgId, dedupHash: "shared-dedup" },
  });
  await db.crmNotification.create({
    data: { id: ids.notificationId, organizationId: orgId, userId, type: "DEAL_ASSIGNED", title: "T", message: "M" },
  });
  await db.crmActivity.create({
    data: { id: ids.activityId, organizationId: orgId, entityType: "COMPANY", entityId: ids.companyId, action: "CREATE" },
  });
  await db.crmTask.create({ data: { id: ids.taskId, organizationId: orgId, title: "Shared Task" } });
  await db.crmNote.create({ data: { id: ids.noteId, organizationId: orgId, body: "Shared note" } });
  await db.crmDealType.create({
    data: { id: ids.dealTypeId, organizationId: orgId, name: "Shared Deal Type", sortOrder: 0 },
  });
}

/**
 * CRM full-domain sweep — Group 2 (deal graph) fixtures. A CrmDeal on the org's
 * Group-1 pipeline stage, with a DealContact (its Group-1 CrmContact),
 * DealProduct (its Group-1 Product), DealDocument, and an EmailThread → Message.
 * Must run AFTER seedCrmGroup1 (needs the stage/contact/product). companyId is
 * left null so the deal→company Restrict is a non-issue; teardown deletes the
 * deal before the org cascade for the deal→stage Restrict.
 */
async function seedCrmGroup2(
  orgId: string,
  deps: {
    dealId: string;
    stageId: string;
    crmContactId: string;
    productId: string;
    dealContactId: string;
    dealProductId: string;
    dealDocId: string;
    threadId: string;
    threadToken: string;
    messageId: string;
  },
) {
  await db.crmDeal.create({
    data: { id: deps.dealId, organizationId: orgId, name: "Shared Deal", stageId: deps.stageId },
  });
  await db.crmDealContact.create({
    data: { id: deps.dealContactId, organizationId: orgId, dealId: deps.dealId, crmContactId: deps.crmContactId },
  });
  await db.crmDealProduct.create({
    data: {
      id: deps.dealProductId,
      organizationId: orgId,
      dealId: deps.dealId,
      crmProductId: deps.productId,
      productName: "Line item",
      category: "Sponsorship",
    },
  });
  await db.crmDealDocument.create({
    data: {
      id: deps.dealDocId,
      organizationId: orgId,
      dealId: deps.dealId,
      url: `/uploads/crm-docs/${deps.dealDocId}.pdf`,
      filename: "prospectus.pdf",
      mimeType: "application/pdf",
      size: 2048,
    },
  });
  await db.crmEmailThread.create({
    data: {
      id: deps.threadId,
      organizationId: orgId,
      dealId: deps.dealId,
      subject: "Re: sponsorship",
      replyToken: deps.threadToken, // GLOBALLY @unique — distinct per org
      counterpartyEmail: "rep@sponsor.test",
    },
  });
  await db.crmEmailMessage.create({
    data: {
      id: deps.messageId,
      organizationId: orgId,
      threadId: deps.threadId,
      direction: "INBOUND",
      fromEmail: "rep@sponsor.test",
    },
  });
}

async function main() {
  // MediaFile → User is a cross-child FK (not org-cascade-ordered), so wipe the
  // media + uploader users explicitly before the org cascade handles the rest.
  await db.mediaFile.deleteMany({
    where: { id: { in: [MEDIA_A_SHARED_ID, MEDIA_B_SHARED_ID, MEDIA_B_ONLY_ID] } },
  });
  await db.user.deleteMany({ where: { id: { in: [UPLOADER_A_ID, UPLOADER_B_ID] } } });
  // CRM Group-2 deals reference a CrmPipelineStage (and could a CrmCompany) via
  // onDelete: Restrict, so the org cascade can't drop the stage while the deal
  // still points at it — delete the deals first (that cascades DealContact/
  // Product/Document and SetNulls the EmailThread; the thread + message are then
  // org-cascaded below). A no-op on the first run.
  await db.crmDeal.deleteMany({ where: { id: { in: [CRM_DEAL_A_ID, CRM_DEAL_B_ID] } } });
  // CrmQuoteCounter's PK IS organizationId and it has NO Organization relation
  // (no FK), so the org cascade never reaches it — delete it explicitly or the
  // re-seed collides on the PK. A no-op on the first run.
  await db.crmQuoteCounter.deleteMany({ where: { organizationId: { in: [ORG_A_ID, ORG_B_ID] } } });
  // Cascade wipes events + contacts + tenant domains + (via Event→Registration
  // →Invoice) the invoice fixtures of prior runs.
  await db.organization.deleteMany({ where: { id: { in: [ORG_A_ID, ORG_B_ID] } } });
  // Attendee is the PARENT of Registration (no org cascade) — now that the org
  // cascade removed the registrations that referenced them, they're deletable.
  await db.attendee.deleteMany({ where: { id: { in: [ATTENDEE_A_ID, ATTENDEE_B_ID] } } });

  await seedOrg(
    ORG_A_ID,
    HOST_A,
    [{ id: EVENT_A_SHARED_ID, slug: SHARED_SLUG }],
    [{ id: CONTACT_A_SHARED_ID, email: SHARED_CONTACT_EMAIL }],
    { id: UPLOADER_A_ID, media: [{ id: MEDIA_A_SHARED_ID, url: SHARED_MEDIA_URL }] },
    [{ id: BILLING_A_SHARED_ID, name: SHARED_PAYER_NAME }],
    {
      eventId: EVENT_A_SHARED_ID,
      attendeeId: ATTENDEE_A_ID,
      registrationId: REG_A_ID,
      invoices: [{ id: INVOICE_A_ID, number: INVOICE_A_NUMBER, seq: 1 }],
      payment: { id: PAYMENT_A_ID, stripePaymentId: PAYMENT_A_STRIPE_PI },
      refundAttemptId: REFUND_ATTEMPT_A_ID,
      ticketing: {
        ticketTypeId: TICKET_TYPE_A_ID,
        pricingTierId: PRICING_TIER_A_ID,
        promoCodeId: PROMO_CODE_A_ID,
        promoCode: SHARED_PROMO_CODE,
        redemptionId: PROMO_REDEMPTION_A_ID,
        linkId: PROMO_LINK_A_ID,
      },
    },
    [{ id: CRM_CT_A_SHARED_ID, emailKey: SHARED_CRM_EMAIL_KEY }],
    [{ id: SPEAKER_A_ID, email: SHARED_SPEAKER_EMAIL, docId: SPEAKER_DOC_A_ID, eventId: EVENT_A_SHARED_ID }],
    {
      hotelId: HOTEL_A_ID,
      hotelName: SHARED_HOTEL_NAME,
      roomTypeId: ROOMTYPE_A_ID,
      accommodationId: ACCOMMODATION_A_ID,
      eventId: EVENT_A_SHARED_ID,
      registrationId: REG_A_ID,
    },
    {
      abstractId: ABSTRACT_A_ID,
      themeId: ABSTRACT_THEME_A_ID,
      themeName: SHARED_ABSTRACT_THEME_NAME,
      criterionId: REVIEW_CRITERION_A_ID,
      reviewerId: ABSTRACT_REVIEWER_A_ID,
      submissionId: ABSTRACT_SUBMISSION_A_ID,
      eventId: EVENT_A_SHARED_ID,
      speakerId: SPEAKER_A_ID,
      reviewerUserId: UPLOADER_A_ID,
    },
    {
      trackId: TRACK_A_ID,
      sessionId: SESSION_A_ID,
      topicId: SESSION_TOPIC_A_ID,
      eventId: EVENT_A_SHARED_ID,
      speakerId: SPEAKER_A_ID,
    },
  );
  await seedCrmGroup1(ORG_A_ID, UPLOADER_A_ID, {
    companyId: CRM_CO_A_ID,
    productId: CRM_PROD_A_ID,
    stageId: CRM_STAGE_A_ID,
    templateId: CRM_TPL_A_ID,
    sendClaimId: CRM_CLAIM_A_ID,
    notificationId: CRM_NOTIF_A_ID,
    activityId: CRM_ACT_A_ID,
    taskId: CRM_TASK_A_ID,
    noteId: CRM_NOTE_A_ID,
    dealTypeId: CRM_DEALTYPE_A_ID,
  });
  await seedCrmGroup2(ORG_A_ID, {
    dealId: CRM_DEAL_A_ID,
    stageId: CRM_STAGE_A_ID,
    crmContactId: CRM_CT_A_SHARED_ID,
    productId: CRM_PROD_A_ID,
    dealContactId: CRM_DC_A_ID,
    dealProductId: CRM_DP_A_ID,
    dealDocId: CRM_DOC_A_ID,
    threadId: CRM_THREAD_A_ID,
    threadToken: CRM_THREAD_A_TOKEN,
    messageId: CRM_MSG_A_ID,
  });
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
    {
      eventId: EVENT_B_SHARED_ID,
      attendeeId: ATTENDEE_B_ID,
      registrationId: REG_B_ID,
      invoices: [
        { id: INVOICE_B_ID, number: INVOICE_B_NUMBER, seq: 1 },
        { id: INVOICE_B_ONLY_ID, number: INVOICE_B_ONLY_NUMBER, seq: 2 },
      ],
      payment: { id: PAYMENT_B_ID, stripePaymentId: PAYMENT_B_STRIPE_PI },
      refundAttemptId: REFUND_ATTEMPT_B_ID,
      ticketing: {
        ticketTypeId: TICKET_TYPE_B_ID,
        pricingTierId: PRICING_TIER_B_ID,
        promoCodeId: PROMO_CODE_B_ID,
        promoCode: SHARED_PROMO_CODE,
        redemptionId: PROMO_REDEMPTION_B_ID,
        linkId: PROMO_LINK_B_ID,
      },
    },
    [
      { id: CRM_CT_B_SHARED_ID, emailKey: SHARED_CRM_EMAIL_KEY },
      { id: CRM_CT_B_ONLY_ID, emailKey: ORG_B_ONLY_CRM_EMAIL_KEY },
    ],
    [
      { id: SPEAKER_B_ID, email: SHARED_SPEAKER_EMAIL, docId: SPEAKER_DOC_B_ID, eventId: EVENT_B_SHARED_ID },
      { id: SPEAKER_B_ONLY_ID, email: ORG_B_ONLY_SPEAKER_EMAIL, docId: "tenancy-spdoc-b-only", eventId: EVENT_B_SHARED_ID },
    ],
    {
      hotelId: HOTEL_B_ID,
      hotelName: SHARED_HOTEL_NAME,
      roomTypeId: ROOMTYPE_B_ID,
      accommodationId: ACCOMMODATION_B_ID,
      eventId: EVENT_B_SHARED_ID,
      registrationId: REG_B_ID,
    },
    {
      abstractId: ABSTRACT_B_ID,
      themeId: ABSTRACT_THEME_B_ID,
      themeName: SHARED_ABSTRACT_THEME_NAME,
      criterionId: REVIEW_CRITERION_B_ID,
      reviewerId: ABSTRACT_REVIEWER_B_ID,
      submissionId: ABSTRACT_SUBMISSION_B_ID,
      eventId: EVENT_B_SHARED_ID,
      speakerId: SPEAKER_B_ID,
      reviewerUserId: UPLOADER_B_ID,
    },
    {
      trackId: TRACK_B_ID,
      sessionId: SESSION_B_ID,
      topicId: SESSION_TOPIC_B_ID,
      eventId: EVENT_B_SHARED_ID,
      speakerId: SPEAKER_B_ID,
    },
  );
  await seedCrmGroup1(ORG_B_ID, UPLOADER_B_ID, {
    companyId: CRM_CO_B_ID,
    productId: CRM_PROD_B_ID,
    stageId: CRM_STAGE_B_ID,
    templateId: CRM_TPL_B_ID,
    sendClaimId: CRM_CLAIM_B_ID,
    notificationId: CRM_NOTIF_B_ID,
    activityId: CRM_ACT_B_ID,
    taskId: CRM_TASK_B_ID,
    noteId: CRM_NOTE_B_ID,
    dealTypeId: CRM_DEALTYPE_B_ID,
  });
  await seedCrmGroup2(ORG_B_ID, {
    dealId: CRM_DEAL_B_ID,
    stageId: CRM_STAGE_B_ID,
    crmContactId: CRM_CT_B_SHARED_ID,
    productId: CRM_PROD_B_ID,
    dealContactId: CRM_DC_B_ID,
    dealProductId: CRM_DP_B_ID,
    dealDocId: CRM_DOC_B_ID,
    threadId: CRM_THREAD_B_ID,
    threadToken: CRM_THREAD_B_TOKEN,
    messageId: CRM_MSG_B_ID,
  });

  console.log(
    "[tenancy:seed] two tenants seeded (shared slug + contact email + media url + payer name + crm emailKey on both; A=1 invoice, B=2)",
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
