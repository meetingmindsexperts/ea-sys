/**
 * Speaker reimbursement — server-only helpers (Node crypto). Kept out of
 * ./constants.ts so the public form page can import the shared validation
 * without dragging Node built-ins into the client bundle (the "button does
 * nothing, no logs" class).
 */

import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant } from "@/lib/public-event";

/**
 * 24 random bytes → 32-char base64url token. Unguessable, URL-safe.
 * Plaintext-in-DB (like RsvpInvite.token / Abstract.managementToken) — the
 * dashboard re-displays the copyable link, so it can't be a one-way hash.
 * Lookup is by the unique `token` column, then event-slug asserted.
 */
export function generateReimbursementToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Public-route loader: resolve a reimbursement by its unique token, then
 * assert it belongs to the URL's event slug (the RSVP pattern — a valid
 * token pasted under another event's slug is a 404, not a cross-event read)
 * AND to the request's tenant (defense-in-depth: a token minted for tenant A
 * must not render on tenant B's domain; tautologically true on master).
 * Shared by the token route and its documents sub-routes (Next route files
 * may only export HTTP handlers, so the helper lives here).
 */
export async function loadReimbursementForSlug(req: Request, slug: string, token: string) {
  const row = await db.speakerReimbursement.findUnique({
    where: { token },
    select: {
      id: true,
      eventId: true,
      status: true,
      fullName: true,
      designation: true,
      institution: true,
      country: true,
      email: true,
      phone: true,
      nationality: true,
      passportNumber: true,
      roleAtEvent: true,
      claimLines: true,
      bankDetails: true,
      signedName: true,
      submittedAt: true,
      speaker: {
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          organization: true,
          jobTitle: true,
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
          eventType: true,
          venue: true,
          city: true,
          organization: { select: { name: true } },
        },
      },
      documents: {
        select: { id: true, kind: true, filename: true, size: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!row || row.event.slug !== slug) return null;
  if (!(await eventMatchesRequestTenant(req, row.event.organizationId))) {
    apiLogger.warn({ slug, eventId: row.eventId }, "reimbursement-public:tenant-mismatch");
    return null;
  }
  return row;
}
