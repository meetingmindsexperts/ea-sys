/**
 * Sample data builder for the preview endpoint.
 *
 * When an organizer hits `/preview?type=ATTENDANCE` without specifying a
 * registrationId, we still want a rendered cert to show — using the event's
 * REAL data (so the CEO/MD reviews against actual branding, dates, and
 * accreditor info) but with a synthetic recipient. This file owns that
 * synthetic recipient + the dispatch to the right "real" recipient when
 * one is supplied.
 *
 * NEVER used in the issue path (Phase C) — that path resolves a real
 * Attendee or Speaker, not the synthetic one here.
 */

import type {
  CertificateData,
  CertificateEventContext,
  CertificateRecipient,
  CertificateExtras,
  CertificateType,
  AccreditationEntry,
  EventCmeSettings,
  CertificateTemplate,
} from "./types";

const SYNTHETIC_RECIPIENT: CertificateRecipient = {
  title: "Dr.",
  firstName: "Sample",
  lastName: "Attendee",
  fullName: "Dr. Sample Attendee",
  organization: "American University of Beirut Medical Center",
  jobTitle: "Consultant Otolaryngologist",
  city: "Beirut",
  country: "Lebanon",
};

interface PreviewEventRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  city: string | null;
  country: string | null;
  cmeHours: { toNumber: () => number } | number | null;
  settings: unknown;
  organization: { name: string; logo: string | null };
}

/**
 * Pull the typed `EventCmeSettings` out of the freeform `settings` JSON.
 * Returns an empty object if the path doesn't exist — equivalent to "no
 * accreditations configured."
 */
export function readEventCmeSettings(settings: unknown): EventCmeSettings {
  if (!settings || typeof settings !== "object") return {};
  const obj = settings as Record<string, unknown>;
  const cme = obj.cme;
  if (!cme || typeof cme !== "object") return {};
  return cme as EventCmeSettings;
}

export function buildEventContext(event: PreviewEventRow): CertificateEventContext {
  const cme = readEventCmeSettings(event.settings);
  const hours =
    event.cmeHours == null
      ? null
      : typeof event.cmeHours === "number"
        ? event.cmeHours
        : event.cmeHours.toNumber();

  return {
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    organizationLogo: event.organization.logo,
    cmeHours: hours,
    accreditations: cme.accreditations ?? [],
  };
}

/**
 * Compose preview-mode CertificateData. The serial is always
 * "PREVIEW-DRAFT-…" so a render that accidentally gets emailed (it
 * can't — the preview endpoint doesn't email) is identifiable as a
 * draft from the cert itself.
 */
export function buildPreviewCertificate(args: {
  type: CertificateType;
  event: PreviewEventRow;
  recipient?: CertificateRecipient;
  /** Organizer-configured template (per-event). When omitted the renderer
   *  falls back to the type default in template.ts. */
  template?: CertificateTemplate;
}): CertificateData {
  const eventCtx = buildEventContext(args.event);
  const extras = extrasForPreview(args.type);
  return {
    type: args.type,
    serial: `PREVIEW-DRAFT-${args.type}`,
    issuedAt: new Date(),
    recipient: args.recipient ?? SYNTHETIC_RECIPIENT,
    event: eventCtx,
    extras,
    template: args.template ?? {},
  };
}

function extrasForPreview(type: CertificateType): CertificateExtras {
  switch (type) {
    case "ATTENDANCE":
      return { type: "ATTENDANCE" };
    case "APPRECIATION":
      // Preview uses a sample abstract title + session title so the
      // organizer sees what `{{abstractTitle}}` / `{{sessionTitles}}`
      // text boxes will look like on a real recipient. On a live run
      // these come from the speaker's actual data (or omitted entirely
      // if they qualified via the SessionSpeaker path with no poster).
      return {
        type: "APPRECIATION",
        sessionTitles: ["Advances in Skull Base Surgery"],
        abstractTitle:
          "Outcomes of Endoscopic Endonasal Approaches in Pediatric Skull Base Tumors",
      };
  }
  // Exhaustiveness backstop — TS can't always prove the switch over a
  // Prisma-generated enum is total. Throws if someone adds a new
  // CertificateType value without updating this map.
  const _exhaustive: never = type;
  throw new Error(`Unhandled certificate type: ${String(_exhaustive)}`);
}

/**
 * Reference accreditations used by the CME preview when the event has none
 * configured yet — so the CEO/MD can see what the block LOOKS like even on
 * a brand-new event. Marked clearly as samples so they don't get confused
 * with a real accreditation.
 */
export const PREVIEW_FALLBACK_ACCREDITATIONS: AccreditationEntry[] = [
  {
    body: "DHA",
    reference: "DHA-CPD-PREVIEW-0000",
    hours: undefined,
  },
];
