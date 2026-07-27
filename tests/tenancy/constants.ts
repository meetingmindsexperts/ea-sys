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
