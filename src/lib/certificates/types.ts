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
 */
export interface CertificateData {
  type: CertificateType;
  serial: string;            // for previews this is "PREVIEW-DRAFT-{type}"
  issuedAt: Date;
  recipient: CertificateRecipient;
  event: CertificateEventContext;
  extras: CertificateExtras;
}
