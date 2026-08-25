/**
 * Public (token) side of Travel Grant. Server-only.
 *
 * ## The ordering trap, and why this file exists
 *
 * `TravelGrant.token` is GLOBALLY unique and plaintext, so under RLS a
 * `findUnique({ token })` issued outside the owning tenant's lane returns
 * NOTHING. The org therefore has to be resolved from the un-swept Event by
 * host+slug BEFORE the token is looked up.
 *
 * Get that backwards and every travel-grant link fail-closes to "invalid" on
 * the platform, while passing every test on master, where RLS is off. That is
 * the worst shape of bug this codebase produces: correct locally, dead in
 * production, and silent in both. Same reasoning and same shape as
 * `resolveReimbursementEventOrg`.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";

/** Resolve the tenant org from the URL's event. Call BEFORE any token lookup. */
export async function resolveTravelGrantEventOrg(
  req: Request,
  slug: string,
): Promise<string | null> {
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug),
    select: { organizationId: true },
  });
  return event?.organizationId ?? null;
}

/**
 * Load a grant by its token, then assert it belongs to the URL's event AND to
 * the request's tenant.
 *
 * The slug assertion is the RSVP pattern: a valid token pasted under another
 * event's slug is a 404, not a cross-event read. The tenant assertion is
 * defense in depth, and tautologically true on master.
 */
export async function loadTravelGrantForSlug(req: Request, slug: string, token: string) {
  const row = await db.travelGrant.findUnique({
    where: { token },
    select: {
      id: true,
      eventId: true,
      status: true,
      signedName: true,
      submittedAt: true,
      countryAtConsent: true,
      speaker: {
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          organization: true,
          country: true,
        },
      },
      event: {
        select: {
          id: true,
          slug: true,
          name: true,
          organizationId: true,
          bannerImage: true,
          bannerImageMobile: true,
          startDate: true,
          endDate: true,
          timezone: true,
          venue: true,
          city: true,
          settings: true,
          travelGrantTermsHtml: true,
          organization: { select: { name: true } },
        },
      },
    },
  });
  if (!row || row.event.slug !== slug) return null;
  if (!(await eventMatchesRequestTenant(req, row.event.organizationId))) {
    apiLogger.warn({ slug, eventId: row.eventId }, "travel-grant-public:tenant-mismatch");
    return null;
  }
  return row;
}
