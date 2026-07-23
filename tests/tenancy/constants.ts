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
