/**
 * Presenter (abstract-author) agreement — the abstract-flow parallel of the
 * faculty speaker agreement (src/lib/speaker-agreement.ts).
 *
 * Per-author, per-event: one acceptance by the author (a `Speaker`) covers ALL
 * of their abstracts for the event. Acceptance is recorded on the author's
 * Speaker row in the DISTINCT `presenterAgreement*` columns (separate from the
 * faculty `agreement*` columns, so a person can hold both independently).
 *
 * Content comes from `Event.abstractTermsHtml` (edited as "Presenter Agreement"
 * under Content → Abstracts), falling back to DEFAULT_PRESENTER_AGREEMENT_HTML.
 * The PDF attachment reuses the shared `renderAgreementHtmlToPdf` renderer so
 * the online acceptance page and the emailed PDF read identical text.
 */
import { db } from "@/lib/db";
import { renderAgreementHtmlToPdf, loadAgreementPdfImage } from "@/lib/speaker-agreement";
import { DEFAULT_PRESENTER_AGREEMENT_HTML } from "@/lib/default-terms";
import { formatPersonName, getTitleLabel } from "@/lib/utils";
import { resolveTimezone, formatDateInTz } from "@/lib/event-time";
import { PRESENTATION_TYPE_LABELS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

export const PRESENTER_AGREEMENT_PDF_MIME = "application/pdf";

/** Token identifier prefix for the one-time acceptance link. */
export const PRESENTER_AGREEMENT_IDENTIFIER_PREFIX = "presenter-agreement:";

export interface PresenterAgreementContext {
  title: string;
  firstName: string;
  lastName: string;
  presenterName: string;
  presenterEmail: string;
  presenterOrganization: string;
  presenterCountry: string;
  jobTitle: string;
  eventName: string;
  eventStartDate: string;
  eventEndDate: string;
  /** Leading-separator range, e.g. " — 1 July 2026 to 3 July 2026" (or ""). */
  eventDateRange: string;
  eventVenue: string;
  eventAddress: string;
  eventCity: string;
  organizationName: string;
  signedDate: string;
  /** Newline-free, comma-joined list of the author's abstract titles. */
  abstractTitles: string;
  abstractCount: string;
  presentationTypes: string;
  themeNames: string;
}

function escapeHtmlForAgreement(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "event";
}

/**
 * Merge `{{token}}` placeholders in the agreement HTML with the presenter
 * context. Unknown tokens are left as-is (typos surface visibly). Values are
 * HTML-escaped. Mirrors `mergeAgreementHtml` in speaker-agreement.ts.
 */
export function mergePresenterAgreementHtml(html: string, ctx: PresenterAgreementContext): string {
  const values: Record<string, string> = {
    title: ctx.title,
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    presenterName: ctx.presenterName,
    presenterEmail: ctx.presenterEmail,
    presenterOrganization: ctx.presenterOrganization,
    presenterCountry: ctx.presenterCountry,
    jobTitle: ctx.jobTitle,
    eventName: ctx.eventName,
    eventStartDate: ctx.eventStartDate,
    eventEndDate: ctx.eventEndDate,
    eventDateRange: ctx.eventDateRange,
    eventVenue: ctx.eventVenue,
    eventAddress: ctx.eventAddress,
    eventCity: ctx.eventCity,
    organizationName: ctx.organizationName,
    signedDate: ctx.signedDate,
    abstractTitles: ctx.abstractTitles,
    abstractCount: ctx.abstractCount,
    presentationTypes: ctx.presentationTypes,
    themeNames: ctx.themeNames,
  };

  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      return escapeHtmlForAgreement(values[key as keyof typeof values] ?? "");
    }
    return match;
  });
}

/**
 * Build the merge context for a presenter (abstract author) — the author's
 * identity, the event, and the set of abstracts they've submitted for it.
 * Returns null when the speaker/event pair can't be resolved.
 */
export async function buildPresenterAgreementContext(
  eventId: string,
  speakerId: string,
): Promise<PresenterAgreementContext | null> {
  const [speaker, event, abstracts] = await Promise.all([
    db.speaker.findFirst({
      where: { id: speakerId, eventId },
      select: {
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        country: true,
        jobTitle: true,
      },
    }),
    db.event.findFirst({
      where: { id: eventId },
      select: {
        name: true,
        startDate: true,
        endDate: true,
        venue: true,
        address: true,
        city: true,
        timezone: true,
        organization: { select: { name: true } },
      },
    }),
    db.abstract.findMany({
      where: { speakerId, eventId },
      select: {
        title: true,
        presentationType: true,
        theme: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!speaker || !event) return null;

  const tz = resolveTimezone(event.timezone);
  const start = formatDateInTz(event.startDate, tz);
  const end = formatDateInTz(event.endDate, tz);
  const eventDateRange = start ? (end && end !== start ? ` — ${start} to ${end}` : ` — ${start}`) : "";

  const titles = abstracts.map((a) => a.title).filter(Boolean);
  const types = Array.from(
    new Set(
      abstracts
        .map((a) => (a.presentationType ? PRESENTATION_TYPE_LABELS[a.presentationType] ?? a.presentationType : ""))
        .filter(Boolean),
    ),
  );
  const themes = Array.from(new Set(abstracts.map((a) => a.theme?.name).filter((n): n is string => !!n)));

  return {
    title: getTitleLabel(speaker.title),
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    presenterName: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
    presenterEmail: speaker.email,
    presenterOrganization: speaker.organization ?? "",
    presenterCountry: speaker.country ?? "",
    jobTitle: speaker.jobTitle ?? "",
    eventName: event.name,
    eventStartDate: start,
    eventEndDate: end,
    eventDateRange,
    eventVenue: event.venue ?? "",
    eventAddress: event.address ?? "",
    eventCity: event.city ?? "",
    organizationName: event.organization?.name ?? "",
    signedDate: formatDateInTz(new Date(), tz),
    abstractTitles: titles.join("; "),
    abstractCount: String(titles.length),
    presentationTypes: types.join(", "),
    themeNames: themes.join(", "),
  };
}

/**
 * Resolve the event's presenter-agreement HTML merged with the author's
 * context. Used by BOTH the public acceptance page and the PDF generator so
 * the author reads identical text online and in the email attachment.
 */
export async function resolvePresenterAgreementHtml(
  eventId: string,
  speakerId: string,
): Promise<{ html: string; context: PresenterAgreementContext } | null> {
  const event = await db.event.findFirst({
    where: { id: eventId },
    select: { abstractTermsHtml: true },
  });
  if (!event) return null;

  const context = await buildPresenterAgreementContext(eventId, speakerId);
  if (!context) return null;

  const raw = event.abstractTermsHtml?.trim() || DEFAULT_PRESENTER_AGREEMENT_HTML;
  const merged = mergePresenterAgreementHtml(raw, context);
  return { html: merged, context };
}

/**
 * Render the merged presenter agreement to a PDF buffer (email attachment).
 * Reuses the shared `renderAgreementHtmlToPdf` renderer.
 */
export async function generatePresenterAgreementPdf(opts: {
  eventId: string;
  speakerId: string;
}): Promise<{ buffer: Buffer; filename: string } | null> {
  const { eventId, speakerId } = opts;

  const resolved = await resolvePresenterAgreementHtml(eventId, speakerId);
  if (!resolved) return null;

  const event = await db.event.findFirst({
    where: { id: eventId },
    select: {
      slug: true,
      name: true,
      presenterAgreementPdfHeaderImage: true,
      presenterAgreementPdfFooterImage: true,
    },
  });
  if (!event) return null;

  // The presenter agreement carries its OWN letterhead pair (July 17, 2026 —
  // distinct columns from the speaker agreement's), loaded failure-isolated.
  const [headerImage, footerImage] = await Promise.all([
    loadAgreementPdfImage(event.presenterAgreementPdfHeaderImage, eventId, "header"),
    loadAgreementPdfImage(event.presenterAgreementPdfFooterImage, eventId, "footer"),
  ]);

  const buffer = await renderAgreementHtmlToPdf({
    html: resolved.html,
    docTitle: `Presenter Agreement — ${event.name}`,
    docAuthor: resolved.context.organizationName,
    headingTitle: "Presenter Agreement",
    headingSubtitle: event.name,
    // Presenter-only signature (matches the speaker agreement): no organizer
    // counter-signature; blank space above the line for an e-signature.
    signatureLabel: "Presenter",
    signatureName: resolved.context.presenterName,
    headerImage,
    footerImage,
  });

  const filename = `presenter-agreement-${slugify(event.slug)}-${slugify(resolved.context.lastName || "presenter")}.pdf`;
  return { buffer, filename };
}
