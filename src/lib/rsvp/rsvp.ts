/**
 * Customizable RSVP — shared helpers.
 *
 * The model: an event runs N INDEPENDENT RSVPs (`RsvpCampaign` — a gala
 * dinner, a set of parallel workshops, a site visit). Each campaign owns its
 * own `RsvpItem`s AND its own `RsvpInvite` list, which is the point: the
 * dinner audience and the workshop audience are different people.
 *
 * Each invitee is one `RsvpInvite` carrying a unique token; their link
 * `/e/{slug}/rsvp/{token}` covers all items IN THAT CAMPAIGN. Per-item
 * attendance + guest count live in `RsvpResponse`; one dietary note lives on
 * the invite. A person on two campaigns holds two invites and two links —
 * the asks are separate (different deadlines, different chase cycles).
 *
 * The token is plaintext-in-DB and unguessable (192 bits, base64url) — like
 * `Abstract.managementToken`, the dashboard re-displays the link, so it can't
 * be a one-way hash. Lookup is by the unique `token` column (global), then we
 * assert the invite's event matches the URL slug.
 *
 * Was "Dinner RSVP" until August 2026; the physical tables keep their old
 * names via @@map (see prisma/schema.prisma).
 *
 * Docs: docs/RSVP.md, docs/CUSTOMIZABLE_RSVP_PLAN.md.
 */

import crypto from "crypto";
import { z } from "zod";

/** 24 random bytes → 32-char base64url token. Unguessable, URL-safe. */
export function generateRsvpToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Trim + lowercase for stable de-dup on `(campaignId, inviteeEmail)`. */
export function normalizeRsvpEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Validation ─────────────────────────────────────────────────────

export const rsvpEmailSchema = z.string().trim().min(3).max(200).email();

export const rsvpSelectionModeSchema = z.enum(["SINGLE", "MULTI"]);
export type RsvpSelectionModeValue = z.infer<typeof rsvpSelectionModeSchema>;

/** One item (a dinner, a workshop slot, a tour) as authored by the organizer. */
export const rsvpItemInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startsAt: z.string().datetime(),
  location: z.string().trim().max(300).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  rsvpDeadline: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export type RsvpItemInput = z.infer<typeof rsvpItemInputSchema>;

/** The campaign's own fields. Defaults reproduce the historical dinner behavior. */
export const rsvpCampaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  selectionMode: rsvpSelectionModeSchema.optional(),
  allowGuests: z.boolean().optional(),
  collectDietary: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

/**
 * Create payload. `firstItem` is what keeps the campaign INVISIBLE to an
 * organizer running a single dinner: the console's one create form supplies
 * both, so the flow stays the same three steps it has always been (plan §2a).
 */
export const rsvpCampaignCreateSchema = rsvpCampaignFieldsSchema.extend({
  firstItem: rsvpItemInputSchema.optional(),
});
export type RsvpCampaignCreate = z.infer<typeof rsvpCampaignCreateSchema>;

/** Partial update — every field optional, but at least one present. */
export const rsvpCampaignUpdateSchema = rsvpCampaignFieldsSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

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
 * Cross-field guard (review R2 L7): an RSVP deadline AFTER the item itself
 * would keep the roster editable after the meal is served. Enforced in both
 * item routes against the EFFECTIVE (merged) values, because the PUT is
 * partial — a schema-level refine can't see the stored counterpart field.
 */
export function isDeadlineAfterItem(
  startsAt: Date | string,
  rsvpDeadline: Date | string | null | undefined,
): boolean {
  if (!rsvpDeadline) return false;
  return new Date(rsvpDeadline).getTime() > new Date(startsAt).getTime();
}

/** The public submit body: per-item attendance + guests, one dietary note. */
export const rsvpSubmitSchema = z.object({
  token: z.string().min(1).max(200),
  dietary: z.string().trim().max(1000).optional().or(z.literal("")),
  items: z
    .array(
      z.object({
        itemId: z.string().min(1).max(100),
        attending: z.boolean(),
        guestCount: z.number().int().min(0).max(20),
      }),
    )
    .max(50),
});
export type RsvpSubmit = z.infer<typeof rsvpSubmitSchema>;

/**
 * SINGLE-mode guard, enforced SERVER-side and not just by the radio group —
 * a crafted POST naming two items is a 400, never a silent first-wins.
 * Declining everything (zero attending) is always allowed in both modes.
 */
export function violatesSelectionMode(
  mode: RsvpSelectionModeValue,
  attendingCount: number,
): boolean {
  return mode === "SINGLE" && attendingCount > 1;
}

// ── Aggregation (organizer roster + headcount tiles) ───────────────

export interface RsvpItemLite {
  id: string;
  name: string;
  startsAt: Date;
}
export interface RsvpResponseLite {
  itemId: string;
  attending: boolean;
  guestCount: number;
}
export interface RsvpInviteLite {
  status: string;
  responses: RsvpResponseLite[];
}

export interface RsvpItemHeadcount {
  itemId: string;
  attendees: number; // invitees marked attending
  guests: number; // sum of their guest counts
  total: number; // attendees + guests
}

/**
 * Per-item headcount across all invites — the "Day 1: 42 (+8)" tiles.
 * Pure; operates on already-loaded rows so it never issues a query.
 */
export function computeItemHeadcounts(
  items: RsvpItemLite[],
  invites: RsvpInviteLite[],
): RsvpItemHeadcount[] {
  const byItem = new Map<string, RsvpItemHeadcount>(
    items.map((i) => [i.id, { itemId: i.id, attendees: 0, guests: 0, total: 0 }]),
  );
  for (const invite of invites) {
    for (const r of invite.responses) {
      if (!r.attending) continue;
      const row = byItem.get(r.itemId);
      if (!row) continue; // response for a since-deleted item
      row.attendees += 1;
      row.guests += r.guestCount;
      row.total += 1 + r.guestCount;
    }
  }
  return items.map((i) => byItem.get(i.id)!);
}

/** RESPONDED + attending at least one item. */
export function isAttendingAny(invite: RsvpInviteLite): boolean {
  return invite.status === "RESPONDED" && invite.responses.some((r) => r.attending);
}
