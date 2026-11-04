/**
 * The ID and document request link (Nov 4, 2026): each person's own link to a
 * page that asks only for what their registration type requires and their
 * registration does not hold yet. Built for the 73 MEHF2027 Student and
 * Resident presenters whose abstract sign-up never asked (see
 * type-evidence.ts); it works for any registration on any type.
 *
 * The link is a VerificationToken (hashed, like the survey and registration
 * form links), so it needs no table of its own. Its identifier names the
 * registration: `evidence:<registrationId>`.
 *
 * Client-safe.
 */

const PREFIX = "evidence:";

export function evidenceRequestIdentifier(registrationId: string): string {
  return `${PREFIX}${registrationId}`;
}

/** The registration a token is for, or null when the token is another kind. */
export function parseEvidenceRequestIdentifier(identifier: string): string | null {
  if (!identifier.startsWith(PREFIX)) return null;
  const registrationId = identifier.slice(PREFIX.length);
  return registrationId.length > 0 ? registrationId : null;
}

/** Why a selected registration got no request. Reported to the organiser, never silent. */
export type EvidenceRequestSkipReason = "NOT_FOUND" | "CANCELLED" | "NOTHING_ASKED" | "NOTHING_MISSING";

export const EVIDENCE_REQUEST_SKIP_LABELS: Record<EvidenceRequestSkipReason, string> = {
  NOT_FOUND: "not found",
  CANCELLED: "cancelled",
  NOTHING_ASKED: "their registration type asks for no ID or document",
  NOTHING_MISSING: "already provided everything",
};

/** The send dialog's starting lifetime: long enough to chase a reply. */
export const DEFAULT_EVIDENCE_REQUEST_EXPIRY_DAYS = 14;

/** The public page a link opens. */
export function evidenceRequestPath(slug: string, rawToken: string): string {
  return `/e/${encodeURIComponent(slug)}/verify-details?token=${rawToken}`;
}
