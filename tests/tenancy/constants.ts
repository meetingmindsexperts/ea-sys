/**
 * Fixed fixture ids for the tenant-isolation harness (tests/tenancy).
 * Two orgs; each has one PUBLISHED event on the SAME slug — proving the
 * slug-ambiguity (`Event.slug` is only unique per org) is real, not
 * theoretical — plus one org-unique-slug event each for cross-tenant-miss
 * assertions. TenantDomain rows map one host per org.
 */
export const ORG_A_ID = "tenancy-org-a";
export const ORG_B_ID = "tenancy-org-b";

export const HOST_A = "a.tenancy.test";
export const HOST_B = "b.tenancy.test";

/** Both orgs hold an event on this slug — the collision case. */
export const SHARED_SLUG = "shared-slug";
export const EVENT_A_SHARED_ID = "tenancy-ev-a-shared";
export const EVENT_B_SHARED_ID = "tenancy-ev-b-shared";

/** One slug that exists ONLY in org B (cross-tenant miss assertions). */
export const ORG_B_ONLY_SLUG = "org-b-only";
export const EVENT_B_ONLY_ID = "tenancy-ev-b-only";

/**
 * Contacts pilot (Phase 2): BOTH orgs hold a contact on this email —
 * `Contact.email` is only unique per org (`@@unique([organizationId,
 * email])`), the same per-org-uniqueness ambiguity the shared event slug
 * proves. Plus one contact that exists ONLY in org B for cross-tenant-miss
 * assertions.
 */
export const SHARED_CONTACT_EMAIL = "shared.person@tenancy.test";
export const CONTACT_A_SHARED_ID = "tenancy-ct-a-shared";
export const CONTACT_B_SHARED_ID = "tenancy-ct-b-shared";

export const ORG_B_ONLY_CONTACT_EMAIL = "only.in.b@tenancy.test";
export const CONTACT_B_ONLY_ID = "tenancy-ct-b-only";

/**
 * MediaFile fast-follow (Phase 2, domain pass #2). MediaFile carries a direct
 * organizationId column (the trivial case) but has NO per-org-unique field, so
 * BOTH orgs hold a file on the SAME url string — proving an unscoped
 * `where:{ url }` still returns only the caller's row under RLS. Plus a B-only
 * file for cross-tenant-miss assertions. Each org needs an uploader User row
 * (MediaFile.uploadedById is a required FK).
 */
export const UPLOADER_A_ID = "tenancy-user-a";
export const UPLOADER_B_ID = "tenancy-user-b";

export const SHARED_MEDIA_URL = "/uploads/media/2027/01/shared-tenancy.png";
export const MEDIA_A_SHARED_ID = "tenancy-mf-a-shared";
export const MEDIA_B_SHARED_ID = "tenancy-mf-b-shared";

export const ORG_B_ONLY_MEDIA_URL = "/uploads/media/2027/01/only-b-tenancy.png";
export const MEDIA_B_ONLY_ID = "tenancy-mf-b-only";

/**
 * BillingAccount sweep (Phase 2, domain pass #3 — the first FULL finance
 * sweep). BillingAccount is `@@unique([organizationId, name])`, so — like the
 * Contact email — BOTH orgs hold a payer on the SAME name, proving per-org
 * coexistence + that an unscoped `where:{ name }` returns only the caller's
 * row. Plus a B-only payer for cross-tenant-miss assertions. No FK to User
 * (unlike MediaFile), so it cascades cleanly from Organization.
 */
export const SHARED_PAYER_NAME = "Shared Payer Co";
export const BILLING_A_SHARED_ID = "tenancy-ba-a-shared";
export const BILLING_B_SHARED_ID = "tenancy-ba-b-shared";

export const ORG_B_ONLY_PAYER_NAME = "Only-In-B Payer";
export const BILLING_B_ONLY_ID = "tenancy-ba-b-only";

/**
 * Invoice sweep (Phase 2, domain pass #4 — second finance domain). Invoice has
 * a direct organizationId column but `invoiceNumber` is GLOBALLY @unique, so
 * unlike Contact/BillingAccount there is no shared-value collision to lean on —
 * scoping is proven by (a) each lane's findMany returning only ITS invoices and
 * (b) an unscoped by-invoiceNumber / by-id lookup of B's invoice missing under
 * A's store. An Invoice requires a Registration → Attendee chain, so each org
 * gets one Attendee + Registration to hang its invoices on. Attendee has NO
 * organizationId (event-scoped via Registration) and is the PARENT of
 * Registration, so it does NOT cascade from Organization — main() deletes the
 * attendees explicitly (after the org cascade removes the registrations that
 * reference them), same cross-child-FK care as MediaFile→User.
 */
export const ATTENDEE_A_ID = "tenancy-att-a";
export const ATTENDEE_B_ID = "tenancy-att-b";
export const REG_A_ID = "tenancy-reg-a";
export const REG_B_ID = "tenancy-reg-b";

export const INVOICE_A_ID = "tenancy-inv-a";
export const INVOICE_A_NUMBER = "TEN-A-INV-001";
export const INVOICE_B_ID = "tenancy-inv-b";
export const INVOICE_B_NUMBER = "TEN-B-INV-001";
// B-only second invoice — the target for cross-tenant-miss + defence-#1 tests.
export const INVOICE_B_ONLY_ID = "tenancy-inv-b-only";
export const INVOICE_B_ONLY_NUMBER = "TEN-B-INV-002";

/**
 * Registration-core sweep (Phase 2, domain pass #8). The Attendee/Registration
 * chain above (Invoice fixtures) doubles as this domain's spine — migration
 * 20260728160000 gave all 5 core tables a denormalized organizationId, and the
 * seed now stamps it. BOTH attendees share ONE email (Attendee.email is not
 * unique) so the unscoped by-email lookup — the exact shape of the public
 * register's orphan-reuse findFirst — proves per-lane scoping. Payment's
 * stripePaymentId is globally @unique (invoice-number pattern: per-lane counts
 * + cross-tenant miss). RegistrationSerialCounter is keyed by eventId (PK) —
 * one row per shared event, org-stamped.
 */
export const SHARED_ATTENDEE_EMAIL = "shared.attendee@tenancy.test";
export const PAYMENT_A_ID = "tenancy-pay-a";
export const PAYMENT_A_STRIPE_PI = "pi_tenancy_a_001";
export const PAYMENT_B_ID = "tenancy-pay-b";
export const PAYMENT_B_STRIPE_PI = "pi_tenancy_b_001";
export const REFUND_ATTEMPT_A_ID = "tenancy-ra-a";
export const REFUND_ATTEMPT_B_ID = "tenancy-ra-b";

/**
 * Ticketing follow-on sweep (Domain #8 carve-off). Hangs off the same
 * Attendee/Registration chain: a TicketType + PricingTier on each org's shared
 * event, a PromoCode (BOTH orgs use the SAME code string — `@@unique([eventId,
 * code])` lets them coexist since the events differ, proving an unscoped
 * by-code lookup is lane-scoped), a PromoCodeRedemption on each org's own
 * registration, and a PromoCodeTicketType link. migration 20260730120000
 * org-stamped all 5.
 */
export const TICKET_TYPE_A_ID = "tenancy-tt-a";
export const TICKET_TYPE_B_ID = "tenancy-tt-b";
export const PRICING_TIER_A_ID = "tenancy-pt-a";
export const PRICING_TIER_B_ID = "tenancy-pt-b";
export const SHARED_PROMO_CODE = "TENANCY10";
export const PROMO_CODE_A_ID = "tenancy-pc-a";
export const PROMO_CODE_B_ID = "tenancy-pc-b";
export const PROMO_REDEMPTION_A_ID = "tenancy-pcr-a";
export const PROMO_REDEMPTION_B_ID = "tenancy-pcr-b";
export const PROMO_LINK_A_ID = "tenancy-pcl-a";
export const PROMO_LINK_B_ID = "tenancy-pcl-b";

/**
 * Speaker domain sweep (Phase 2). Speaker is @@unique([eventId, email]) — a
 * per-event uniqueness — so BOTH orgs hold a speaker on the SAME email string
 * (different events), proving an unscoped by-email lookup is lane-scoped (the
 * ticketing shared-code shape). Plus a B-only speaker for cross-tenant-miss.
 * SpeakerDocument (2-hop via speakerId → Speaker) has no unique-value field;
 * each org's speaker gets one document, proving the 2-hop backfill is
 * independently lane-scoped. Speaker cascades from Event (org cascade reaches
 * it) and SpeakerDocument from Speaker — no explicit teardown needed.
 */
export const SHARED_SPEAKER_EMAIL = "shared.speaker@tenancy.test";
export const SPEAKER_A_ID = "tenancy-sp-a";
export const SPEAKER_B_ID = "tenancy-sp-b";
export const SPEAKER_DOC_A_ID = "tenancy-spdoc-a";
export const SPEAKER_DOC_B_ID = "tenancy-spdoc-b";

export const ORG_B_ONLY_SPEAKER_EMAIL = "only.in.b.speaker@tenancy.test";
export const SPEAKER_B_ONLY_ID = "tenancy-sp-b-only";

/**
 * Accommodation domain sweep (Phase 2, Domain #10). Hotel / RoomType /
 * Accommodation — the clean case (every row → one Event → one org, migration
 * 20260731100000 backfilled 1/2-hop). Hotel/RoomType carry no per-org-unique
 * field, so BOTH orgs hold a hotel on the SAME name — proving an unscoped
 * `where:{ name }` returns only the caller's row (the MediaFile shared-url
 * shape). Each hotel gets one RoomType (2-hop backfill via Hotel), and each org
 * gets one Accommodation on its OWN registration (REG_A/REG_B) + roomtype —
 * proving the 1-hop Accommodation lane is independently scoped. All cascade from
 * Event (org cascade reaches them) — no explicit teardown.
 */
export const SHARED_HOTEL_NAME = "Shared Grand Hotel";
export const HOTEL_A_ID = "tenancy-hotel-a";
export const HOTEL_B_ID = "tenancy-hotel-b";
export const ROOMTYPE_A_ID = "tenancy-rt-a";
export const ROOMTYPE_B_ID = "tenancy-rt-b";
export const ACCOMMODATION_A_ID = "tenancy-acc-a";
export const ACCOMMODATION_B_ID = "tenancy-acc-b";

/**
 * Abstract domain sweep (Phase 2, Domain #11). Abstract/AbstractTheme/
 * ReviewCriterion (1-hop from Event) + AbstractReviewer/AbstractReviewSubmission
 * (2-hop via Abstract). The reviewer/submitter User is org-independent, but each
 * ROW belongs to the abstract's event's org. Each org gets one abstract on its
 * OWN speaker (SPEAKER_A_ID/B) + shared event, one theme (BOTH orgs share the
 * name — `@@unique([eventId, name])` lets them coexist, proving an unscoped
 * by-name lookup is lane-scoped), one review criterion, and an AbstractReviewer
 * + AbstractReviewSubmission for the org's uploader User (UPLOADER_A_ID/B) acting
 * as reviewer — proving the 2-hop tables are independently lane-scoped. All
 * cascade from Event/Abstract (org cascade reaches them).
 */
export const SHARED_ABSTRACT_THEME_NAME = "Cardiology";
export const ABSTRACT_A_ID = "tenancy-abs-a";
export const ABSTRACT_B_ID = "tenancy-abs-b";
export const ABSTRACT_THEME_A_ID = "tenancy-atheme-a";
export const ABSTRACT_THEME_B_ID = "tenancy-atheme-b";
export const REVIEW_CRITERION_A_ID = "tenancy-rc-a";
export const REVIEW_CRITERION_B_ID = "tenancy-rc-b";
export const ABSTRACT_REVIEWER_A_ID = "tenancy-arev-a";
export const ABSTRACT_REVIEWER_B_ID = "tenancy-arev-b";
export const ABSTRACT_SUBMISSION_A_ID = "tenancy-asub-a";
export const ABSTRACT_SUBMISSION_B_ID = "tenancy-asub-b";

/**
 * Sessions/Tracks domain sweep (Phase 2, Domain #12). Track/EventSession (1-hop) +
 * SessionTopic (2-hop) + SessionSpeaker/TopicSpeaker (composite-PK join tables,
 * 2/3-hop). Each org gets one Track → EventSession → SessionTopic chain, with a
 * SessionSpeaker + TopicSpeaker linking the org's own speaker (SPEAKER_A_ID/B).
 * Proves 1/2/3-hop backfill + composite-PK-table lane-scoping. All cascade from
 * Event (org cascade reaches them).
 */
export const TRACK_A_ID = "tenancy-trk-a";
export const TRACK_B_ID = "tenancy-trk-b";
export const SESSION_A_ID = "tenancy-sess-a";
export const SESSION_B_ID = "tenancy-sess-b";
export const SESSION_TOPIC_A_ID = "tenancy-stopic-a";
export const SESSION_TOPIC_B_ID = "tenancy-stopic-b";

/**
 * Certificates domain sweep (Phase 2, Domain #13). CertificateTemplate /
 * IssuedCertificate / CertificateIssueRun / CertificateSerialCounter (1-hop from
 * Event) + CertificateIssueRunItem (2-hop via CertificateIssueRun). Each org gets
 * one template (BOTH orgs share the name — CertificateTemplate has no per-org
 * unique, so an unscoped `where:{ name }` returns only the caller's row, the
 * MediaFile shared-value shape), one IssuedCertificate on the org's OWN
 * registration (REG_A/REG_B — the serial is GLOBALLY @unique so scoping is proven
 * by per-lane count + cross-tenant by-id/by-serial miss, the Invoice shape), one
 * CertificateIssueRun + one CertificateIssueRunItem (2-hop) on it, and one
 * CertificateSerialCounter (composite-PK flat-column counter, keyed by
 * eventId+type — one per org's shared event). All cascade from Event (org cascade
 * reaches them); the run item cascades from the run.
 */
export const SHARED_CERT_TEMPLATE_NAME = "Attendance Certificate";
export const CERT_TEMPLATE_A_ID = "tenancy-ctpl-a";
export const CERT_TEMPLATE_B_ID = "tenancy-ctpl-b";
export const ISSUED_CERT_A_ID = "tenancy-icert-a";
export const ISSUED_CERT_B_ID = "tenancy-icert-b";
export const CERT_A_SERIAL = "TEN-A-ATT-0001";
export const CERT_B_SERIAL = "TEN-B-ATT-0001";
export const CERT_RUN_A_ID = "tenancy-crun-a";
export const CERT_RUN_B_ID = "tenancy-crun-b";
export const CERT_RUN_ITEM_A_ID = "tenancy-critem-a";
export const CERT_RUN_ITEM_B_ID = "tenancy-critem-b";

/**
 * Session Proposals sweep (Domain #14). SessionProposal + SessionProposalTheme.
 * The theme NAME is SHARED across both orgs (only @@unique([eventId, name]) — no
 * per-org-unique field), so an unscoped by-name lookup returning only the
 * caller's row proves lane-scoping. Each proposal hangs on the org's own speaker.
 */
export const SHARED_SESSION_PROPOSAL_THEME_NAME = "Clinical Innovations";
export const SESSION_PROPOSAL_THEME_A_ID = "tenancy-spt-a";
export const SESSION_PROPOSAL_THEME_B_ID = "tenancy-spt-b";
export const SESSION_PROPOSAL_A_ID = "tenancy-sprop-a";
export const SESSION_PROPOSAL_B_ID = "tenancy-sprop-b";

/**
 * Dinner RSVP sweep (Domain #15). RsvpDinner + RsvpInvite (1-hop) +
 * RsvpDinnerResponse (2-hop). The invitee EMAIL is SHARED across both orgs
 * (@@unique is [eventId, inviteeEmail] — no per-org-unique on email alone), so
 * an unscoped by-email lookup returning only the caller's row proves lane
 * scoping. The token is GLOBALLY unique, so a cross-tenant findUnique({ token })
 * returning null proves the public-route bootstrap (a token minted for A is
 * invisible on B's lane — exactly why the route resolves org from Event first).
 * Each org gets a dinner + invite + a response on that invite (2-hop chain).
 */
export const SHARED_RSVP_INVITEE_EMAIL = "vip@tenancy.test";
export const RSVP_DINNER_A_ID = "tenancy-rdin-a";
export const RSVP_DINNER_B_ID = "tenancy-rdin-b";
export const RSVP_INVITE_A_ID = "tenancy-rinv-a";
export const RSVP_INVITE_B_ID = "tenancy-rinv-b";
export const RSVP_INVITE_A_TOKEN = "tenancy-rtok-a-0000000000000000";
export const RSVP_INVITE_B_TOKEN = "tenancy-rtok-b-0000000000000000";
export const RSVP_RESPONSE_A_ID = "tenancy-rresp-a";
export const RSVP_RESPONSE_B_ID = "tenancy-rresp-b";

/**
 * Survey sweep (Domain #16). One SurveyResponse per org, hung on the org's own
 * registration (registrationId is GLOBALLY unique — the one-response dedup
 * gate) on the SHARED event slug. A cross-tenant findUnique({ registrationId })
 * must miss (the IssuedCertificate-serial / RSVP-token proof shape).
 */
export const SURVEY_RESPONSE_A_ID = "tenancy-srsp-a";
export const SURVEY_RESPONSE_B_ID = "tenancy-srsp-b";

/**
 * Reimbursement sweep (Domain #17). One SpeakerReimbursement per org on the
 * org's own speaker (speakerId is GLOBALLY unique — one form per speaker) with
 * a GLOBALLY-unique plaintext token (the public link — a cross-tenant
 * findUnique({ token }) must miss, the RSVP-token bootstrap proof) + one
 * document each (the 2-hop chain).
 */
export const REIMB_A_ID = "tenancy-reimb-a";
export const REIMB_B_ID = "tenancy-reimb-b";
export const REIMB_A_TOKEN = "tenancy-rmtok-a-000000000000000";
export const REIMB_B_TOKEN = "tenancy-rmtok-b-000000000000000";
export const REIMB_DOC_A_ID = "tenancy-rmdoc-a";
export const REIMB_DOC_B_ID = "tenancy-rmdoc-b";

/**
 * Comms-log sweep (Domain #18): one EmailLog row per org — both tagged with
 * the SAME recipient address (EmailLog has no per-org unique field, so the
 * shared `to` is what proves lane-scoping, the MediaFile shape) — plus one
 * ScheduledEmail per org (non-null org since birth). EMAIL_LOG_NULLORG_ID is
 * minted BY THE TEST via a bare (store-less) app_user insert — the asymmetric
 * WITH CHECK write-half proof; it's cleaned up in the seed's main() because
 * EmailLog's org FK is SetNull (rows survive the org cascade).
 */
export const EMAIL_LOG_A_ID = "tenancy-elog-a";
export const EMAIL_LOG_B_ID = "tenancy-elog-b";
export const EMAIL_LOG_NULLORG_ID = "tenancy-elog-nullorg";
export const SHARED_EMAIL_TO = "tenancy-shared-recipient@example.com";
export const SCHED_EMAIL_A_ID = "tenancy-sched-a";
export const SCHED_EMAIL_B_ID = "tenancy-sched-b";

/**
 * CrmContact policy pass (Phase 2, domain pass #5 — policy-only, like
 * MediaFile's first pass; unblocked July 24 when the CRM deployed).
 * CrmContact is `@@unique([organizationId, emailKey])`, so — like the event
 * Contact — BOTH orgs hold a business contact on the SAME emailKey, proving
 * per-org coexistence + that an unscoped `where:{ emailKey }` returns only the
 * caller's row. Plus a B-only contact for cross-tenant-miss assertions. All
 * FKs (company/owner/contactId) are nullable, so rows cascade cleanly from
 * Organization — no cross-child cleanup needed.
 */
export const SHARED_CRM_EMAIL_KEY = "shared.rep@tenancy.test";
export const CRM_CT_A_SHARED_ID = "tenancy-crmct-a-shared";
export const CRM_CT_B_SHARED_ID = "tenancy-crmct-b-shared";

export const ORG_B_ONLY_CRM_EMAIL_KEY = "only.in.b.rep@tenancy.test";
export const CRM_CT_B_ONLY_ID = "tenancy-crmct-b-only";

/**
 * CRM full-domain sweep — POLICY LAYER, Group 1 (July 2026). The 10 simple
 * direct-org Crm* models (no CRM-internal FK parent needed). Each org gets ONE
 * row per model; the B row doubles as the cross-tenant-miss / delete target for
 * A's store. All carry a direct organizationId → the flat policy; scoping is
 * proven by (a) each lane's findMany returning only ITS rows and (b) an unscoped
 * by-id lookup/delete of B's row missing under A's store (defence #2). All rows
 * cascade from Organization; CrmNotification.userId (required, onDelete Cascade)
 * points at the org's already-seeded uploader User. CrmQuoteCounter's PK IS
 * organizationId, so it has no separate id (keyed on ORG_A_ID / ORG_B_ID).
 */
export const CRM_CO_A_ID = "tenancy-crmco-a";
export const CRM_CO_B_ID = "tenancy-crmco-b";
export const CRM_PROD_A_ID = "tenancy-crmprod-a";
export const CRM_PROD_B_ID = "tenancy-crmprod-b";
export const CRM_STAGE_A_ID = "tenancy-crmstage-a";
export const CRM_STAGE_B_ID = "tenancy-crmstage-b";
export const CRM_TPL_A_ID = "tenancy-crmtpl-a";
export const CRM_TPL_B_ID = "tenancy-crmtpl-b";
export const CRM_CLAIM_A_ID = "tenancy-crmclaim-a";
export const CRM_CLAIM_B_ID = "tenancy-crmclaim-b";
export const CRM_NOTIF_A_ID = "tenancy-crmnotif-a";
export const CRM_NOTIF_B_ID = "tenancy-crmnotif-b";
export const CRM_ACT_A_ID = "tenancy-crmact-a";
export const CRM_ACT_B_ID = "tenancy-crmact-b";
export const CRM_TASK_A_ID = "tenancy-crmtask-a";
export const CRM_TASK_B_ID = "tenancy-crmtask-b";
export const CRM_NOTE_A_ID = "tenancy-crmnote-a";
export const CRM_NOTE_B_ID = "tenancy-crmnote-b";
// CrmDealType (the admin-editable deal-type list, added July 29) — a simple
// direct-org Group-1-shape model; @@unique([organizationId, name]) so both orgs
// share the name.
export const CRM_DEALTYPE_A_ID = "tenancy-crmdealtype-a";
export const CRM_DEALTYPE_B_ID = "tenancy-crmdealtype-b";

/**
 * CRM full-domain sweep — POLICY LAYER, Group 2 (the deal graph). Each org gets
 * a CrmDeal (on its Group-1 pipeline stage) hanging DealContact / DealProduct /
 * DealDocument / EmailThread → EmailMessage off it. WITH CHECK is proven per
 * model via the re-home UPDATE path (parents unchanged/visible), which avoids
 * the FK-vs-RLS ambiguity a cross-org create-smuggle would hit on RLS-gated
 * required parents; INSERT-side WITH CHECK is already proven by Group 1's flat
 * (byte-identical) policy. CrmEmailThread.replyToken is GLOBALLY @unique, so the
 * two orgs use distinct tokens. Teardown deletes the deals before the org
 * cascade — CrmDeal→CrmPipelineStage/CrmCompany are onDelete: Restrict.
 */
export const CRM_DEAL_A_ID = "tenancy-crmdeal-a";
export const CRM_DEAL_B_ID = "tenancy-crmdeal-b";
export const CRM_DC_A_ID = "tenancy-crmdc-a";
export const CRM_DC_B_ID = "tenancy-crmdc-b";
export const CRM_DP_A_ID = "tenancy-crmdp-a";
export const CRM_DP_B_ID = "tenancy-crmdp-b";
export const CRM_DOC_A_ID = "tenancy-crmdoc-a";
export const CRM_DOC_B_ID = "tenancy-crmdoc-b";
export const CRM_THREAD_A_ID = "tenancy-crmthread-a";
export const CRM_THREAD_B_ID = "tenancy-crmthread-b";
export const CRM_THREAD_A_TOKEN = "tenancy-thread-token-a";
export const CRM_THREAD_B_TOKEN = "tenancy-thread-token-b";
export const CRM_MSG_A_ID = "tenancy-crmmsg-a";
export const CRM_MSG_B_ID = "tenancy-crmmsg-b";
