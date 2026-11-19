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
 *
 * This is a SAFETY bound, not a display choice: the route updates the contacts
 * one at a time inside a single transaction with a 30 second limit, so the
 * number is what that loop can finish, and raising it means measuring the loop
 * first. It must never be below the largest page, because "select all" on a
 * full page sends the whole page; a test holds the two together, so adding a
 * larger page size fails until this is raised on purpose.
 */
export const CONTACT_BULK_TAG_MAX: number = 1000;

/**
 * The most contacts one Import from Contacts takes, as registrations or as
 * speakers (Nov 19, 2026). A SAFETY bound: the registrations import creates
 * each person one at a time inside one transaction with Prisma's 5 second
 * default, and since the dialog keeps picks across pages an organiser could
 * pick hundreds and get an unexplained failure with nothing imported. The
 * dialog refuses a pick past it, and both routes answer a clear 400.
 */
export const CONTACT_IMPORT_MAX = 200;

export const CONTACT_IMPORT_TOO_MANY = `At most ${CONTACT_IMPORT_MAX} contacts in one import. Import them in batches.`;
