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
