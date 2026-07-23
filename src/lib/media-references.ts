/**
 * "Is this media file still referenced?" — the guard behind media-library
 * deletes.
 *
 * Media-library DELETE removes the file from disk AND the MediaFile row, but
 * nothing used to check whether anything still pointed at the URL — deleting
 * an image that an event's email branding referenced left a dangling <img>
 * that 404'd in every email sent from then on (found July 23, 2026:
 * 4GHH2026's emailFooterImage — broken footer image in every confirmation).
 *
 * Checks the high-value reference surfaces:
 *   - Event branding columns (email header/footer image, banner, mobile banner)
 *   - Organizer-authored HTML content columns (Tiptap-inserted images:
 *     welcome/terms/guidelines/survey intro + the email footer HTML)
 *   - Saved EmailTemplate bodies (Tiptap media-picker inserts)
 *   - The organization logo
 *
 * Deliberately NOT checked: already-SENT EmailLog bodies (history — the
 * damage there is done and undoable only by restoring the file) and
 * speaker/attendee photos (a different upload store, /uploads/photos/).
 *
 * Shared by BOTH delete routes (org media library + event media library) —
 * one implementation, per the no-cross-caller-duplication rule.
 */
import { db } from "@/lib/db";

export interface MediaReference {
  kind: "event-branding" | "event-content" | "email-template" | "organization-logo";
  /** Human-readable location, e.g. `4th GCC Hematology Hub 2026 — email footer image`. */
  label: string;
}

const BRANDING_FIELDS = [
  ["emailHeaderImage", "email header image"],
  ["emailFooterImage", "email footer image"],
  ["bannerImage", "banner image"],
  ["bannerImageMobile", "mobile banner image"],
] as const;

const CONTENT_FIELDS = [
  ["registrationWelcomeHtml", "registration welcome content"],
  ["abstractWelcomeHtml", "abstract welcome content"],
  ["registrationTermsHtml", "registration terms"],
  ["abstractGuidelinesHtml", "abstract guidelines"],
  ["surveyIntroHtml", "survey intro"],
  ["emailFooterHtml", "email footer content"],
] as const;

export async function findMediaReferences(
  url: string,
  organizationId: string
): Promise<MediaReference[]> {
  const [brandingEvents, contentEvents, templates, org] = await Promise.all([
    db.event.findMany({
      where: {
        organizationId,
        OR: BRANDING_FIELDS.map(([field]) => ({ [field]: url })),
      },
      select: {
        name: true,
        emailHeaderImage: true,
        emailFooterImage: true,
        bannerImage: true,
        bannerImageMobile: true,
      },
    }),
    db.event.findMany({
      where: {
        organizationId,
        OR: CONTENT_FIELDS.map(([field]) => ({ [field]: { contains: url } })),
      },
      select: {
        name: true,
        registrationWelcomeHtml: true,
        abstractWelcomeHtml: true,
        registrationTermsHtml: true,
        abstractGuidelinesHtml: true,
        surveyIntroHtml: true,
        emailFooterHtml: true,
      },
    }),
    db.emailTemplate.findMany({
      where: {
        htmlContent: { contains: url },
        event: { organizationId },
      },
      select: { name: true, event: { select: { name: true } } },
    }),
    db.organization.findFirst({
      where: { id: organizationId, logo: url },
      select: { name: true },
    }),
  ]);

  const refs: MediaReference[] = [];
  for (const e of brandingEvents) {
    for (const [field, label] of BRANDING_FIELDS) {
      if (e[field] === url) refs.push({ kind: "event-branding", label: `${e.name} — ${label}` });
    }
  }
  for (const e of contentEvents) {
    for (const [field, label] of CONTENT_FIELDS) {
      if (e[field]?.includes(url)) refs.push({ kind: "event-content", label: `${e.name} — ${label}` });
    }
  }
  for (const t of templates) {
    refs.push({ kind: "email-template", label: `${t.event.name} — email template "${t.name}"` });
  }
  if (org) refs.push({ kind: "organization-logo", label: `${org.name} — organization logo` });
  return refs;
}

/** One human sentence for the 409 body — fetchApi surfaces `error` verbatim
 *  in the existing toast paths, so this is what the organizer reads. */
export function mediaInUseMessage(refs: MediaReference[]): string {
  const shown = refs.slice(0, 3).map((r) => r.label).join("; ");
  const more = refs.length > 3 ? ` (+${refs.length - 3} more)` : "";
  return `This image is still in use: ${shown}${more}. Remove or replace it there first, then delete it.`;
}
