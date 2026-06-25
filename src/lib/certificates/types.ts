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

// ── Certificate template (organizer-controlled — PDF overlay model) ─────────
//
// Architecture v3 (2026-06-02): organizers upload a finished cert PDF
// produced by their designer (banner / borders / signatures / footer logos
// all baked into the PDF). Our job is to position text boxes containing
// {{tokens}} on top of that PDF, then per-recipient substitute the tokens
// and overlay the text using pdf-lib. Matches the EventsAir/CertifyMe
// pattern; user's organizer rejected our compose-from-assets approach
// because designers want to own the entire visual.
//
// Old shape (CertificateSignature + CertificateFooterLogo + body/footer
// HTML) is kept exported below for one release cycle so any in-flight
// references compile, but the renderer ignores them. Hard cut-over per
// the 2026-06-02 plan — no migration of old data, organizers re-upload
// as a single PDF.

/** Standard fonts available via pdf-lib's StandardFonts enum. Subset shown
 *  in the UI; complete enum supported by the renderer. */
export type CertificateFontName =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

export type TextBoxAlign = "left" | "center" | "right";

/** One positioned text box on the cert PDF background.
 *
 * Coordinates are in pdf-lib points (1pt = 1/72") with (0,0) at the
 * BOTTOM-LEFT of the page (PDF convention). The canvas editor converts
 * from browser pixel coords (top-left origin, scaled to viewer width)
 * to PDF coords at save time. Width controls text wrapping + alignment
 * anchor; height is informational (the renderer just draws from y down).
 *
 * `content` is plain text with `{{tokens}}` — same merge tokens as the
 * old template body (recipientName / eventName / eventDateRange /
 * venueLine / accreditationBody / accreditationReference / cmeHours).
 * Single line per box; multi-line + rich text were explicitly out of
 * scope per the 2026-06-02 confirmation. */
export interface CertificateTextBox {
  /** Stable id (cuid or uuid generated at create time) — used as the
   *  React key in the editor and to target updates. */
  id: string;
  /** Text + tokens — e.g. "Dr. {{recipientName}}" or just "{{cmeHours}}". */
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font: CertificateFontName;
  /** Font size in points. */
  size: number;
  /** Hex color — 6 digits, e.g. "#1a2e5a". */
  color: string;
  align: TextBoxAlign;
}

// Legacy v2 shapes — retained for one release so old serialized
// templates parse without TS errors. Renderer ignores them.
export interface CertificateSignature {
  image?: string | null;
  name: string;
  lines: string[];
}
export interface CertificateFooterLogo {
  label?: string;
  image: string;
}

/**
 * Per-cert-type templates for an event. Two slots (Attendance +
 * Appreciation), each holding a `CertificateTemplate` (uploaded
 * background PDF + positioned text boxes). Collapsed from 4 to 2 on
 * 2026-06-02 to match the designer workflow — Appreciation absorbed
 * the old PRESENTER / POSTER / CME slots. CME metadata stays on the
 * event row and renders via `{{cmeHours}}` etc. on whichever template
 * needs it.
 */
export type EventCertificateTemplates = {
  ATTENDANCE?: CertificateTemplate;
  APPRECIATION?: CertificateTemplate;
};

/**
 * Per-event-per-type certificate template (v3 PDF-overlay model).
 *
 * Lives at `Event.settings.certificateTemplates[CertificateType]`. Each
 * of the four cert types (Attendance / Presenter / Poster / CME) has
 * its own slot — the designer typically produces 4 separate cert PDFs.
 *
 * `backgroundPdfUrl` is the uploaded finished-design PDF (single page).
 * `textBoxes` are positioned overlay text boxes containing static text +
 * {{tokens}} that get token-substituted per recipient at issue time.
 *
 * Legacy fields from v2 (headerImage, titleText, titleColor, bodyTemplate,
 * signatures, footerLogos, footerText) are kept optional for backward
 * compatibility during the deserialization phase, but the renderer
 * ignores them. The settings API reads them as "missing" → caller sees
 * empty arrays so the new editor surface treats it as unconfigured.
 */
export interface CertificateTemplate {
  /** URL to the uploaded background PDF — single page. Organizer's
   *  designer produces this externally (Photoshop / Illustrator / Canva
   *  → PDF export). Whatever's in this PDF becomes the cert's visual
   *  identity; the platform only paints text boxes on top. */
  backgroundPdfUrl?: string | null;
  /** Positioned text overlays — each renders at its (x, y) on the PDF
   *  with its content tokens substituted per recipient. */
  textBoxes?: CertificateTextBox[];
  /** Role/designation this template certifies (e.g. "Speaker", "Moderator").
   *  Drives the {{role}} token. */
  role?: string | null;
  /** Static per-template CME hours — drives {{cmeHours}}, overriding the
   *  event-level CME hours when set. */
  cmeHours?: number | null;
  /** SUPER_ADMIN-only design-approval gate (preserved from prior
   *  architecture; unlocks Phase C "Issue" button). */
  designApprovedBy?: string;
  designApprovedAt?: string;

  // ── Legacy v2 fields (ignored by renderer, kept for soft-deserialize) ──
  /** @deprecated v2 banner image — ignored by v3 renderer. */
  headerImage?: string | null;
  /** @deprecated v2 title text — ignored by v3 renderer. */
  titleText?: string;
  /** @deprecated v2 title color — ignored by v3 renderer. */
  titleColor?: string;
  /** @deprecated v2 body HTML — ignored by v3 renderer. */
  bodyTemplate?: string;
  /** @deprecated v2 signatures — ignored by v3 renderer. */
  signatures?: CertificateSignature[];
  /** @deprecated v2 footer logos — ignored by v3 renderer. */
  footerLogos?: CertificateFooterLogo[];
  /** @deprecated v2 footer text — ignored by v3 renderer. */
  footerText?: string;
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
 * Cert-type-specific extras. Discriminated by `type` so the renderer
 * can narrow without runtime checks. Post enum collapse (2026-06-02)
 * APPRECIATION optionally carries the abstract title — set when the
 * recipient qualifies via the old "poster" path so the template can
 * render `{{abstractTitle}}` if the organizer adds a text box for it.
 * CME hours + accreditations live on the event context and render via
 * `{{cmeHours}}` / `{{accreditationBody}}` tokens on either cert type.
 */
export type CertificateExtras =
  | { type: "ATTENDANCE" }
  | { type: "APPRECIATION"; abstractTitle?: string | null; sessionTitles?: string[] };

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
