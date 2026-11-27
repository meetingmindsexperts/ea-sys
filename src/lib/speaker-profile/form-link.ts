/**
 * A speaker's profile form link (photo, bio and documents): the one place that
 * makes the form row and builds its address. Called by the speaker page's
 * "send the form" route and by every send whose text names
 * {{profileFormLink}} (the bulk pipeline and a speaker's own Send Email), so
 * the doors cannot drift.
 */
import { db } from "@/lib/db";
import { generateProfileFormToken } from "@/lib/speaker-profile/server";

export function profileFormUrl(appUrl: string, eventSlug: string, token: string): string {
  return `${appUrl}/e/${eventSlug}/speaker-form/${token}`;
}

/**
 * The speaker's form row, made on first use. One per speaker, and the token
 * never changes, so a link in an earlier email keeps working.
 */
export function ensureProfileForm(p: {
  eventId: string;
  organizationId: string | null;
  speakerId: string;
  /** The staff user behind the send; null for a scheduled one. */
  createdById: string | null;
}) {
  return db.speakerProfileForm.upsert({
    where: { speakerId: p.speakerId },
    create: {
      eventId: p.eventId,
      organizationId: p.organizationId,
      speakerId: p.speakerId,
      token: generateProfileFormToken(),
      createdById: p.createdById,
    },
    update: {},
    select: { id: true, token: true, status: true },
  });
}

const PROFILE_FORM_LINK_RE = /\{\{profileFormLink\}\}/;

/**
 * {{profileFormLink}} for ONE speaker in any send. Nothing is made unless a
 * text names the token; a failure throws, so the caller fails that one
 * recipient instead of sending a dead link.
 */
export async function profileFormLinkForSend(
  p: Parameters<typeof ensureProfileForm>[0] & {
    appUrl: string;
    eventSlug: string;
    /** Every text the send renders (template parts, typed subject and message). */
    texts: Array<string | null | undefined>;
  },
): Promise<{ profileFormLink: string }> {
  if (!p.texts.some((t) => !!t && PROFILE_FORM_LINK_RE.test(t))) return { profileFormLink: "" };
  const form = await ensureProfileForm(p);
  return { profileFormLink: profileFormUrl(p.appUrl, p.eventSlug, form.token) };
}
