/**
 * Speaker profile form — CLIENT-SAFE shared constants + validation (Aug 4,
 * 2026). The public form page ("use client") imports this, so it must stay
 * free of Node built-ins (the "button does nothing, no logs" class) —
 * server-only helpers live in ./server.ts (the reimbursement split).
 *
 * The form collects: a headshot PHOTO (→ Speaker.photo, required unless the
 * speaker already has one), a PASSPORT photocopy (required), a COVER LETTER
 * (optional) and the speaker's BIO (optional, → Speaker.bio). The two files
 * are stored as SpeakerDocument rows (kind OTHER with the fixed labels
 * below) so they surface on the existing per-speaker Documents card —
 * "matching the existing attachment fields" rather than a parallel store.
 */

import { z } from "zod";

/** The two upload slots. ONE document per slot — re-upload replaces. */
export const PROFILE_DOC_SLOTS = ["passport", "cover_letter"] as const;
export type ProfileDocSlot = (typeof PROFILE_DOC_SLOTS)[number];

/**
 * SpeakerDocument.label per slot — the SAME rows the organizer sees on the
 * speaker page's Documents card. Matching happens on these exact labels.
 */
export const PROFILE_DOC_LABELS: Record<ProfileDocSlot, string> = {
  passport: "Passport copy",
  cover_letter: "Cover letter",
};

export const PROFILE_DOC_SLOT_TITLES: Record<ProfileDocSlot, string> = {
  passport: "Passport photocopy",
  cover_letter: "Cover letter",
};

/** Owner decision (Aug 4): passport required, cover letter optional. */
export const REQUIRED_PROFILE_DOC_SLOTS: ProfileDocSlot[] = ["passport"];

/** Documents: PDF or a phone photo of the passport. 10 MB (speaker-docs cap). */
export const PROFILE_DOC_MAX_SIZE = 10 * 1024 * 1024;
export const PROFILE_DOC_ACCEPT = "application/pdf,image/jpeg,image/png";

/** Photo: same rules as every other photo upload in the system. */
export const PROFILE_PHOTO_MAX_SIZE = 500 * 1024;
export const PROFILE_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

export const MAX_PROFILE_BIO_LENGTH = 5000;

/** Submit payload — files ride separate multipart uploads; submit is JSON. */
export const profileSubmitSchema = z.object({
  bio: z.string().max(MAX_PROFILE_BIO_LENGTH).optional(),
});

/**
 * The docs can be uploaded by EITHER the speaker (via this form) or the
 * organizer (Documents card, free-text label) — so slot matching accepts a
 * few obvious label spellings, case-insensitively, not just the canonical
 * PROFILE_DOC_LABELS value.
 */
const SLOT_ALIASES: Record<ProfileDocSlot, string[]> = {
  passport: ["passport copy", "passport", "passport photocopy", "passport scan", "passport photo page"],
  cover_letter: ["cover letter", "coverletter", "cover-letter"],
};

/** The slot a document label fills, or null when it's an unrelated document. */
export function profileSlotForLabel(label: string | null | undefined): ProfileDocSlot | null {
  const norm = (label ?? "").trim().toLowerCase();
  if (!norm) return null;
  for (const slot of PROFILE_DOC_SLOTS) {
    if (SLOT_ALIASES[slot].includes(norm)) return slot;
  }
  return null;
}

// ── What a speaker is asked for (Nov 19, 2026) ───────────────────────────────
/**
 * The organiser chooses what the speaker's form link collects (owner, Nov 19,
 * 2026: "give control to organizer just like reimbursement"). Before this
 * every speaker was asked for the same things, and a local or webinar speaker
 * could not submit without a passport copy they had no reason to send.
 *
 * ASKED OR NOT, nothing finer (owner's choice A): an item is on the form or
 * off it, and the rules for an item that is on are the ones it always had:
 * a photo and a passport copy are required, a bio and a cover letter are not,
 * and a presentation never holds up the form (slides come later).
 *
 * Stored the way reimbursement's claim items are:
 *   - Event default: `Event.settings.speakerProfile.items`. ABSENT (or
 *     unreadable, or empty) means ALL FIVE, so an event that never touched
 *     the setting behaves exactly as before.
 *   - Per speaker: `Speaker.profileFormItems`. Null = the event default; a
 *     saved list REPLACES it, never intersects it: asking one speaker for a
 *     passport on an event that asks nobody is the point of the override.
 * The form shows only the asked items, and every public door refuses an item
 * that is not asked, so a page left open across a change cannot send what
 * was withdrawn.
 */
export const PROFILE_ITEMS = [
  { key: "photo", label: "Photo", hint: "A headshot for the programme. Required when asked, unless we already have one." },
  { key: "bio", label: "Bio", hint: "A short biography. Optional for the speaker." },
  { key: "passport", label: "Passport copy", hint: "For visas and travel. Required when asked." },
  { key: "cover_letter", label: "Cover letter or CV", hint: "Optional for the speaker." },
  { key: "presentation", label: "Presentation", hint: "Slides or a video for each talk. Can be sent later and replaced." },
] as const;

export type ProfileItemKey = (typeof PROFILE_ITEMS)[number]["key"];
export const PROFILE_ITEM_KEYS = PROFILE_ITEMS.map((i) => i.key) as [ProfileItemKey, ...ProfileItemKey[]];

/** At least one: an empty set would make a form with nothing on it and no way to tell why. In the list's own order. */
export const profileItemsSchema = z
  .array(z.enum(PROFILE_ITEM_KEYS))
  .min(1)
  .transform((keys) => PROFILE_ITEM_KEYS.filter((k) => keys.includes(k)));

/** Body of the event default's PUT. */
export const profileItemsInputSchema = z.object({ items: profileItemsSchema });
/** Body of a speaker's own list: null goes back to the event default. */
export const speakerProfileItemsInputSchema = z.object({ items: profileItemsSchema.nullable() });

function readProfileItemList(value: unknown): ProfileItemKey[] | null {
  if (!Array.isArray(value)) return null;
  const keys = PROFILE_ITEM_KEYS.filter((k) => (value as unknown[]).includes(k));
  return keys.length > 0 ? keys : null;
}

/** What the event asks its speakers for. Absent, unreadable or empty: all five. */
export function readEventProfileItems(settings: unknown): ProfileItemKey[] {
  const block = (settings as { speakerProfile?: { items?: unknown } } | null | undefined)?.speakerProfile;
  return readProfileItemList(block?.items) ?? [...PROFILE_ITEM_KEYS];
}

/** A speaker's own list, or null to use the event default. */
export function readSpeakerProfileItems(value: unknown): ProfileItemKey[] | null {
  return readProfileItemList(value);
}

/** What one speaker is asked for: their own list when set, else the event's. */
export function askedProfileItems(input: { eventSettings: unknown; speakerItems: unknown }): ProfileItemKey[] {
  return readSpeakerProfileItems(input.speakerItems) ?? readEventProfileItems(input.eventSettings);
}

export function profileItemLabel(key: string): string {
  return PROFILE_ITEMS.find((i) => i.key === key)?.label ?? key;
}

/** "Photo, Bio, Presentation". */
export function profileItemsSummary(items: readonly ProfileItemKey[]): string {
  return items.map(profileItemLabel).join(", ");
}

/** What the request email asks the speaker to have ready, one line per asked item. Fixed text: nothing typed by anyone. */
const PROFILE_ITEM_EMAIL_LINES: Record<ProfileItemKey, string> = {
  photo: "A recent headshot photo (JPG or PNG, under 500KB).",
  bio: "Your short biography, to review or write.",
  passport: "A scan or clear phone photo of your passport photo page (PDF, JPG or PNG). This is required.",
  cover_letter: "A cover letter or CV, if applicable.",
  presentation: "Your presentation (slides or a video), which you can send later and replace.",
};

/** `{{profileFormAsks}}` (HTML list) and `{{profileFormAsksText}}` for the request email: only what this speaker is asked for. */
export function profileFormAsksVars(items: readonly ProfileItemKey[]): { profileFormAsks: string; profileFormAsksText: string } {
  const lines = items.map((k) => PROFILE_ITEM_EMAIL_LINES[k]);
  return {
    profileFormAsks: `<ul style="margin: 0 0 16px 0; padding-left: 20px;">${lines.map((l) => `<li style="margin: 0 0 6px 0;">${l}</li>`).join("")}</ul>`,
    profileFormAsksText: lines.map((l) => `- ${l}`).join("\n"),
  };
}

/** The part of the list that is the form to submit; a presentation is its own section, never submitted. */
export function profileFormItems(items: readonly ProfileItemKey[]): ProfileItemKey[] {
  return items.filter((i) => i !== "presentation");
}

/**
 * Which required slots are still missing, given the labels of the speaker's
 * existing documents and what this speaker is asked for. Pure: shared by the
 * client's submit guard and the server's authoritative re-check. A slot that
 * is not asked is never missing.
 */
export function missingProfileDocSlots(
  existingLabels: Array<string | null | undefined>,
  asked: readonly ProfileItemKey[] = PROFILE_ITEM_KEYS,
): ProfileDocSlot[] {
  const have = new Set(existingLabels.map(profileSlotForLabel).filter(Boolean));
  return REQUIRED_PROFILE_DOC_SLOTS.filter((slot) => asked.includes(slot) && !have.has(slot));
}
