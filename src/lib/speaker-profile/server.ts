/**
 * Speaker profile form — server-only helpers (Node crypto, db). Kept out of
 * ./constants.ts so the public form page can import the shared validation
 * without dragging Node built-ins into the client bundle.
 *
 * Mirrors src/lib/reimbursement/server.ts: plaintext unique token, tenant
 * bootstrap from the un-swept Event first, then token lookup + slug assert +
 * tenant assert.
 */

import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { eventMatchesRequestTenant, publicEventWhere } from "@/lib/public-event";
import { profileSlotForLabel } from "./constants";

/**
 * 24 random bytes → 32-char base64url token. Plaintext-in-DB (like
 * SpeakerReimbursement.token) — the dashboard re-displays the copyable link.
 */
export function generateProfileFormToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Tenancy bootstrap for the public token routes: SpeakerProfileForm reads
 * would fail-close under platform RLS with no tenant store, so resolve the
 * org from the un-swept Event by host+slug FIRST, then run everything inside
 * runWithTenant(<this org>) at the route. Null when the slug doesn't resolve
 * on this host (route 404s).
 */
export async function resolveProfileFormEventOrg(req: Request, slug: string): Promise<string | null> {
  const event = await db.event.findFirst({
    where: await publicEventWhere(req, slug),
    select: { organizationId: true },
  });
  return event?.organizationId ?? null;
}

/**
 * Public-route loader: resolve a profile form by its unique token, assert it
 * belongs to the URL's event slug AND the request's tenant. Returns the form
 * row + speaker prefill + the slot documents (matched via profileSlotForLabel
 * on the speaker's SpeakerDocument rows — the SAME rows the Documents card
 * shows, so an organizer-uploaded "Passport" fills the slot too).
 */
export async function loadProfileFormForSlug(req: Request, slug: string, token: string) {
  const row = await db.speakerProfileForm.findUnique({
    where: { token },
    select: {
      id: true,
      eventId: true,
      status: true,
      submittedAt: true,
      speaker: {
        select: {
          id: true,
          title: true,
          firstName: true,
          lastName: true,
          email: true,
          photo: true,
          bio: true,
          organization: true,
          jobTitle: true,
          documents: {
            where: { kind: "OTHER" },
            select: { id: true, label: true, filename: true, size: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          },
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
          organization: { select: { name: true } },
        },
      },
    },
  });
  if (!row || row.event.slug !== slug) return null;
  if (!(await eventMatchesRequestTenant(req, row.event.organizationId))) {
    apiLogger.warn({ slug, eventId: row.eventId }, "speaker-profile-public:tenant-mismatch");
    return null;
  }
  // Only the slot-filling documents (alias-matched) — other speaker docs
  // (bio doc, CV) are not this form's business and must not leak to it.
  return {
    ...row,
    speaker: {
      ...row.speaker,
      documents: row.speaker.documents.filter((d) => profileSlotForLabel(d.label) !== null),
    },
  };
}
