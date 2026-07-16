/**
 * Dinner RSVP — shared helpers.
 *
 * The model: one event has N dinners (`RsvpDinner`, e.g. Day 1 Dinner,
 * Day 2 Gala). Each invited person is one `RsvpInvite` carrying a unique
 * token; their personalized link `/e/{slug}/rsvp/{token}` covers ALL the
 * event's dinners. Per-dinner attendance + guest count live in
 * `RsvpDinnerResponse` (one row per invite×dinner). A single dietary note
 * lives on the invite.
 *
 * The token is plaintext-in-DB and unguessable (192 bits, base64url) —
 * like `Abstract.managementToken`, the dashboard re-displays the link, so
 * it can't be a one-way hash. Lookup is by the unique `token` column
 * (global), then we assert the invite's event matches the URL slug.
 *
 * Docs: docs/DINNER_RSVP.md.
 */

import crypto from "crypto";
import { z } from "zod";

/** 24 random bytes → 32-char base64url token. Unguessable, URL-safe. */
export function generateRsvpToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Trim + lowercase for stable de-dup on `(eventId, inviteeEmail)`. */
export function normalizeRsvpEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Validation ─────────────────────────────────────────────────────

export const rsvpEmailSchema = z.string().trim().min(3).max(200).email();

/** A dinner as authored by the organizer (create/update payload). */
export const rsvpDinnerInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  dinnerAt: z.string().datetime(),
  location: z.string().trim().max(300).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  rsvpDeadline: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export type RsvpDinnerInput = z.infer<typeof rsvpDinnerInputSchema>;

/** One invitee added to the list (from a picker or typed manually). */
export const rsvpInviteInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: rsvpEmailSchema,
  registrationId: z.string().max(100).optional(),
  speakerId: z.string().max(100).optional(),
});

/** Bulk add — cap protects the token-mint loop + a single audit row. */
export const rsvpInviteBulkSchema = z.object({
  invitees: z.array(rsvpInviteInputSchema).min(1).max(500),
});

/**
 * Cross-field guard (review R2 L7): an RSVP deadline AFTER the dinner itself
 * would keep the roster editable after the meal is served. Enforced in both
 * dinner routes against the EFFECTIVE (merged) values, because the PUT is
 * partial — a schema-level refine can't see the stored counterpart field.
 */
export function isDeadlineAfterDinner(
  dinnerAt: Date | string,
  rsvpDeadline: Date | string | null | undefined,
): boolean {
  if (!rsvpDeadline) return false;
  return new Date(rsvpDeadline).getTime() > new Date(dinnerAt).getTime();
}

/** The public submit body: per-dinner attendance + guests, one dietary note. */
export const rsvpSubmitSchema = z.object({
  token: z.string().min(1).max(200),
  dietary: z.string().trim().max(1000).optional().or(z.literal("")),
  dinners: z
    .array(
      z.object({
        dinnerId: z.string().min(1).max(100),
        attending: z.boolean(),
        guestCount: z.number().int().min(0).max(20),
      }),
    )
    .max(50),
});
export type RsvpSubmit = z.infer<typeof rsvpSubmitSchema>;

// ── Aggregation (organizer roster + headcount tiles) ───────────────

export interface RsvpDinnerLite {
  id: string;
  name: string;
  dinnerAt: Date;
}
export interface RsvpResponseLite {
  dinnerId: string;
  attending: boolean;
  guestCount: number;
}
export interface RsvpInviteLite {
  status: string;
  responses: RsvpResponseLite[];
}

export interface DinnerHeadcount {
  dinnerId: string;
  attendees: number; // invitees marked attending
  guests: number; // sum of their guest counts
  total: number; // attendees + guests
}

/**
 * Per-dinner headcount across all invites — the "Day 1: 42 (+8)" tiles.
 * Pure; operates on already-loaded rows so it never issues a query.
 */
export function computeDinnerHeadcounts(
  dinners: RsvpDinnerLite[],
  invites: RsvpInviteLite[],
): DinnerHeadcount[] {
  const byDinner = new Map<string, DinnerHeadcount>(
    dinners.map((d) => [d.id, { dinnerId: d.id, attendees: 0, guests: 0, total: 0 }]),
  );
  for (const invite of invites) {
    for (const r of invite.responses) {
      if (!r.attending) continue;
      const row = byDinner.get(r.dinnerId);
      if (!row) continue; // response for a since-deleted dinner
      row.attendees += 1;
      row.guests += r.guestCount;
      row.total += 1 + r.guestCount;
    }
  }
  return dinners.map((d) => byDinner.get(d.id)!);
}

/** RESPONDED + attending at least one dinner. */
export function isAttendingAny(invite: RsvpInviteLite): boolean {
  return invite.status === "RESPONDED" && invite.responses.some((r) => r.attending);
}
