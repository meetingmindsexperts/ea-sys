/**
 * How many contacts the Contacts page shows at a time (owner, Nov 18, 2026:
 * 100, 500 or 1,000; it was 20, 50 or 100).
 *
 * One list for the page's "per page" choice and the server's ceiling, so the
 * page can never offer a size the route silently cuts down. No server imports:
 * the page is a client component.
 */
export const CONTACT_PAGE_SIZES = [100, 500, 1000] as const;

/** What the page opens with. */
export const CONTACT_DEFAULT_PAGE_SIZE: (typeof CONTACT_PAGE_SIZES)[number] = 100;

/** The most `GET /api/contacts` returns in one answer, whatever `limit` asks for. */
export const CONTACTS_MAX_PAGE_SIZE: number = Math.max(...CONTACT_PAGE_SIZES);

/**
 * The most contacts one tag change takes (`PATCH /api/contacts/bulk-tags`).
 * "Select all" on a full page sends the whole page, so this is never below
 * the largest page; the route and the page's own refusal both read it.
 */
export const CONTACT_BULK_TAG_MAX: number = CONTACTS_MAX_PAGE_SIZE;
