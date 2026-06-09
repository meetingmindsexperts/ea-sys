/**
 * Organizer-generated shareable survey link.
 *
 * Single source of truth used by:
 *   - the share-link management route (`POST/DELETE
 *     /api/events/[eventId]/survey/share-link`)
 *   - the public survey route's `?share=` GET + POST branches
 *   - the bulk-email survey-invitation expiry (shares the days enum)
 *
 * Storage shape: `Event.surveyShareLink` holds `{ token, expiresAt,
 * createdAt, createdByUserId }` or NULL (see prisma/schema.prisma +
 * migration 20260609120000_add_event_survey_share_link). The token is
 * PLAINTEXT (like `Abstract.managementToken`) so the dashboard can
 * re-display the URL; reaching the form still requires a valid
 * registrant email to submit, so plaintext is acceptable here.
 *
 * Lookup is slug-scoped — the public URL `/e/{slug}/survey?share=...`
 * carries the slug, so the route loads the event by slug and compares
 * the provided token to the stored one (timing-safe). No global token
 * index is needed.
 */

import crypto from "crypto";
import { z } from "zod";

/**
 * Allowed expiration windows (days) for both the shareable link and the
 * bulk-email survey invitation. Single source of truth for the
 * 3/5/7/10 contract shared across the management route, the bulk-email
 * schema, and the scheduled-email worker.
 */
export const SURVEY_EXPIRY_DAYS = [3, 5, 7, 10] as const;
export type SurveyExpiryDays = (typeof SURVEY_EXPIRY_DAYS)[number];

export const surveyExpiryDaysSchema = z.union([
  z.literal(3),
  z.literal(5),
  z.literal(7),
  z.literal(10),
]);

/** Default TTL when an expiry isn't supplied (preserves prior behavior). */
export const DEFAULT_SURVEY_EXPIRY_DAYS: SurveyExpiryDays = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Defensive parse of the stored `Event.surveyShareLink` JSON — mirrors
 * the `readSurveyConfig` pattern (never trust the DB blob shape).
 */
export const surveyShareLinkSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  createdByUserId: z.string(),
});

export type SurveyShareLink = z.infer<typeof surveyShareLinkSchema>;

export function readSurveyShareLink(raw: unknown): SurveyShareLink | null {
  if (raw === null || raw === undefined) return null;
  const result = surveyShareLinkSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** New plaintext share token — same generator as Abstract.managementToken. */
export function generateShareToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export type ShareLinkValidation =
  | { ok: true; link: SurveyShareLink }
  | { ok: false; reason: "none" | "expired" | "mismatch" };

/**
 * Validate a provided `?share=` token against the event's stored link.
 * Uses `crypto.timingSafeEqual` (never `===`) with a length guard first
 * — the token length (64 hex chars) is not secret, so guarding length
 * before the constant-time compare is safe and avoids the throw on
 * mismatched buffer lengths.
 */
export function isShareLinkValid(
  raw: unknown,
  providedToken: string | null | undefined,
  now: Date = new Date(),
): ShareLinkValidation {
  const link = readSurveyShareLink(raw);
  if (!link) return { ok: false, reason: "none" };
  if (!providedToken) return { ok: false, reason: "mismatch" };

  const a = Buffer.from(link.token);
  const b = Buffer.from(providedToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }

  if (new Date(link.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, link };
}

/** Build the public shareable URL. */
export function buildShareUrl(
  appUrl: string,
  slug: string,
  token: string,
): string {
  return `${appUrl}/e/${slug}/survey?share=${token}`;
}

/** Construct a fresh share-link record for storage on the event. */
export function buildShareLinkRecord(
  expiresInDays: SurveyExpiryDays,
  createdByUserId: string,
  now: Date = new Date(),
): SurveyShareLink {
  return {
    token: generateShareToken(),
    expiresAt: new Date(now.getTime() + expiresInDays * DAY_MS).toISOString(),
    createdAt: now.toISOString(),
    createdByUserId,
  };
}
