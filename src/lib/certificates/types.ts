/**
 * Types for the certificate pipeline. The discriminated union here is the
 * single contract the renderer + preview endpoint + (Phase C) issue route
 * all consume — keeps cert-type-specific data shape-checked at compile time
 * instead of plumbed through `any`.
 *
 * Phase A consumers: the preview endpoint + the renderer. Issuing path
 * (which writes IssuedCertificate rows + serials + emails) lands in Phase C
 * and will reuse the same types.
 */

import type { CertificateType } from "@prisma/client";

export type { CertificateType };

/**
 * One accredited body per row. An event in Dubai may carry DHA + EACCME
 * simultaneously, each with its own reference and (rarely) different hour
 * allocations. Stored in `Event.settings.cme.accreditations[]` JSON; lives
 * here as a typed contract so the renderer + settings UI agree on the shape.
 *
 * `officialStatement` overrides the auto-built statement when a specific
 * accreditor requires verbatim wording (e.g., EACCME's exact "designated
 * for a maximum of N European CME credits (ECMEC®s)" boilerplate). When
 * omitted the renderer composes a generic "Accredited by <body> reference
 * <ref> for X hours" string.
 */
export interface AccreditationEntry {
  body: "DHA" | "DOH" | "SCFHS" | "EACCME" | "ACCME" | "OTHER";
  reference: string;
  hours?: number;
  officialStatement?: string;
}

/**
 * The shape persisted in `Event.settings.cme`. The certificates page UI
 * reads/writes this; the renderer reads `accreditations` + the event's
 * top-level `cmeHours`.
 */
export interface EventCmeSettings {
  accreditations?: AccreditationEntry[];
  designApprovedBy?: string;
  designApprovedAt?: string;
}

// ── Certificate template (organizer-controlled visual assets) ─────────────────
//
// Per CEO/MD review of two real-world CME certs (MASH IN FOCUS 2026, EIGHC
// 2025), the cert visual identity lives in event-specific uploaded assets
// — banner image, signature(s), society logos — not in a fixed in-code
// design. The new "template" model lets organizers fully control the
// look while we own the composition + data merge.

/** One signature block. Multi-signature support (chairman + co-chairmen). */
export interface CertificateSignature {
  /** URL to the uploaded hand-signature image (PNG/SVG, transparent bg
   *  preferred — sits over the white cert body). */
  image?: string | null;
  /** Display name shown under the signature line, e.g. "DR. AHMAD AL-RIFAI". */
  name: string;
  /** Free-form lines below the name (title, institution, country, etc).
   *  Each entry renders on its own line in the cert. */
  lines: string[];
}

/** One footer logo with an optional label above it (e.g., "Hosted by",
 *  "In Collaboration with", "Managed by"). */
export interface CertificateFooterLogo {
  /** Optional small label rendered above the logo in muted text. */
  label?: string;
  /** URL to the uploaded logo image. */
  image: string;
}

/**
 * Per-event certificate template. Lives in `Event.settings.certificateTemplate`.
 * All fields are optional so an event without a configured template still
 * renders a default cert (using the static defaults in template.ts).
 *
 * `bodyTemplate` is plain text with `{{token}}` merge placeholders. Supported
 * tokens at render time: recipientName, eventName, eventSubtitle,
 * eventDateRange, venueLine, accreditationBody, accreditationReference,
 * cmeHours. Unknown tokens render as empty string (with a warn log) so a
 * typo doesn't surface `{{cmeHourz}}` literally on a printed cert.
 */
export interface CertificateTemplate {
  /** Banner image URL — typically uploaded by organizer; renders across
   *  the top ~22% of the cert. Aspect ratio responsibility is on the
   *  organizer (they design it once, the renderer just places it). */
  headerImage?: string | null;
  /** Heading text — "Certificate of Attendance" / "Certificate of CME" /
   *  etc. Rendered in italic script style. */
  titleText?: string;
  /** Hex color for the heading — navy by default, but organizers can pick
   *  per event (refs showed navy + magenta). */
  titleColor?: string;
  /** Body text with {{token}} placeholders. Multi-line — each newline
   *  renders as a paragraph. */
  bodyTemplate?: string;
  /** Zero, one, or more signatures (chairman, co-chairmen). When more
   *  than one, signatures render side-by-side. */
  signatures?: CertificateSignature[];
  /** Zero or more society logos at the bottom of the cert. */
  footerLogos?: CertificateFooterLogo[];
  /** Optional text rendered below the footer logos. */
  footerText?: string;
  /** SUPER_ADMIN-only design-approval gate (preserved from prior
   *  architecture; unlocks Phase C "Issue" button). */
  designApprovedBy?: string;
  designApprovedAt?: string;
}

/** Recipient data — flattened from Attendee or Speaker depending on cert type. */
export interface CertificateRecipient {
  title: string | null;     // "Dr." / "Prof." etc — already formatted via getTitleLabel
  firstName: string;
  lastName: string;
  fullName: string;         // formatPersonName output — what renders on the cert
  organization?: string | null;
  jobTitle?: string | null;
  city?: string | null;
  country?: string | null;
}

/** Event-scoped fields the renderer needs. */
export interface CertificateEventContext {
  name: string;
  startDate: Date;
  endDate: Date;
  venue?: string | null;
  city?: string | null;
  country?: string | null;
  organizationName: string;
  organizationLogo?: string | null;  // absolute URL or /uploads/... path
  cmeHours?: number | null;
  accreditations?: AccreditationEntry[];
}

/**
 * Cert-type-specific extras. Discriminated by `type` so the renderer can
 * narrow without runtime checks. POSTER carries the abstract title;
 * PRESENTER carries the session/topic the speaker presented; CME pulls
 * hours + accreditations from the event context.
 */
export type CertificateExtras =
  | { type: "ATTENDANCE" }
  | { type: "PRESENTER"; sessionTitles?: string[] }
  | { type: "POSTER"; abstractTitle?: string | null }
  | { type: "CME" };

/**
 * Single argument passed to `renderCertificate`. Everything the layout
 * needs is here — no DB access happens during rendering, which means
 * the same function is reused identically by Phase A's preview path
 * (where data is mocked or pulled fresh) and Phase C's issue path
 * (where data comes from a frozen recipientSnapshot).
 *
 * `template` is the organizer-controlled visual config (banner image,
 * title, signatures, footer logos, etc.) merged with the renderer's
 * built-in defaults. The renderer treats every template field as
 * optional + falls back to defaults.
 */
export interface CertificateData {
  type: CertificateType;
  serial: string;            // for previews this is "PREVIEW-DRAFT-{type}"
  issuedAt: Date;
  recipient: CertificateRecipient;
  event: CertificateEventContext;
  extras: CertificateExtras;
  template: CertificateTemplate;
}
