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

/**
 * Which required slots are still missing, given the labels of the speaker's
 * existing documents. Pure — shared by the client submit guard and the
 * server's authoritative re-check.
 */
export function missingProfileDocSlots(existingLabels: Array<string | null | undefined>): ProfileDocSlot[] {
  const have = new Set(existingLabels.map(profileSlotForLabel).filter(Boolean));
  return REQUIRED_PROFILE_DOC_SLOTS.filter((slot) => !have.has(slot));
}
