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
